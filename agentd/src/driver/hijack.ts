import { connect } from "node:net"
import type { HijackedExec } from "./types.js"

/**
 * Interactive exec: `POST /sandbox/{name}/exec` with `interactive: true`
 * hijacks the HTTP connection into raw stdio streams (§3.2). undici's
 * generated client can't express that, so this speaks HTTP/1.1 on a raw
 * unix socket: send the request, parse the response head, then treat the
 * remaining bytes as the process's combined stdout/stderr and our writes
 * as its stdin.
 *
 * Docker-lineage daemons multiplex non-TTY streams into 8-byte-framed
 * chunks (type, 3×0, u32 length). Our shim's first output byte is always
 * `{` (NDJSON), so mux framing is auto-detected from the first byte and
 * unwrapped when present.
 *
 * This is the single most sbx-version-sensitive spot in agentd — a natural
 * upstream contribution to sbx-sdk once stable (§5.4).
 */
export function hijackExec(
  socketPath: string,
  sandbox: string,
  cmd: string[],
): Promise<HijackedExec> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    const body = JSON.stringify({ cmd, interactive: true })

    let head = Buffer.alloc(0)
    let upgraded = false
    let muxMode: boolean | undefined
    let lineBuf = ""
    let muxBuf = Buffer.alloc(0)
    let lineCb: ((line: string) => void) | undefined
    let closeCb: ((err?: Error) => void) | undefined
    let closed = false
    const pending: string[] = []

    const finish = (err?: Error) => {
      if (closed) return
      closed = true
      if (lineBuf.trim()) pending.push(lineBuf), (lineBuf = "")
      flushPending()
      closeCb?.(err)
      socket.destroy()
    }

    const flushPending = () => {
      if (!lineCb) return
      while (pending.length) lineCb(pending.shift()!)
    }

    const pushText = (text: string) => {
      lineBuf += text
      let i: number
      while ((i = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, i).replace(/\r$/, "")
        lineBuf = lineBuf.slice(i + 1)
        if (line.length) pending.push(line)
      }
      flushPending()
    }

    const pushStream = (chunk: Buffer) => {
      if (muxMode === undefined && chunk.length > 0)
        muxMode = chunk[0]! <= 2 // frame type byte; NDJSON starts with '{' (0x7b)
      if (!muxMode) {
        pushText(chunk.toString("utf8"))
        return
      }
      muxBuf = Buffer.concat([muxBuf, chunk])
      while (muxBuf.length >= 8) {
        const size = muxBuf.readUInt32BE(4)
        if (muxBuf.length < 8 + size) break
        pushText(muxBuf.subarray(8, 8 + size).toString("utf8"))
        muxBuf = muxBuf.subarray(8 + size)
      }
    }

    socket.on("connect", () => {
      socket.write(
        `POST /sandbox/${encodeURIComponent(sandbox)}/exec HTTP/1.1\r\n` +
          `Host: sandboxd\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          `Connection: Upgrade\r\n` +
          `Upgrade: tcp\r\n` +
          `\r\n` +
          body,
      )
    })

    socket.on("data", (chunk: Buffer) => {
      if (upgraded) {
        pushStream(chunk)
        return
      }
      head = Buffer.concat([head, chunk])
      const sep = head.indexOf("\r\n\r\n")
      if (sep < 0) {
        if (head.length > 64 * 1024) {
          reject(new Error("sandboxd exec: response head too large"))
          socket.destroy()
        }
        return
      }
      const headText = head.subarray(0, sep).toString("utf8")
      const status = Number(headText.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] ?? 0)
      if (status !== 101 && status !== 200) {
        reject(
          new Error(
            `sandboxd exec upgrade failed: HTTP ${status || "?"} ${headText.split("\r\n")[0] ?? ""}`,
          ),
        )
        socket.destroy()
        return
      }
      upgraded = true
      const rest = head.subarray(sep + 4)
      head = Buffer.alloc(0)
      resolve({
        writeLine: (line: string) => {
          if (!closed) socket.write(line.endsWith("\n") ? line : line + "\n")
        },
        onLine: (cb) => {
          lineCb = cb
          flushPending()
        },
        onClose: (cb) => {
          closeCb = cb
          if (closed) cb()
        },
        close: () => finish(),
      })
      if (rest.length) pushStream(rest)
    })

    socket.on("error", (err) => {
      if (!upgraded) reject(err)
      else finish(err)
    })
    socket.on("close", () => {
      if (!upgraded) reject(new Error("sandboxd exec: connection closed before upgrade"))
      else finish()
    })
  })
}
