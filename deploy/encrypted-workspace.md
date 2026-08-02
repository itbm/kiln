# The encrypted workspace mount

Coding chats are the one part of Kiln that writes your data to the server's
disk. This is not a design preference that could be reversed — a git checkout
*is* a filesystem — so the mitigation is that the directory it writes to is
encrypted at rest, and Kiln refuses to start the forge without one configured.

## What actually lands there

`KILN_WORKSPACE_ROOT/<chatId>/` holds, per code chat:

```
repo/            the git checkout — your source, and any secrets already in it
.kiln/claude/    the agent's session transcript: every prompt, tool call and result
.kiln/home/      $HOME for the agent — shell history, gitconfig, package caches
.kiln/uploads/   files you attached to a message
```

The transcript is the sensitive one. It is a complete record of the
conversation *and* of everything the agent read while working.

Kiln relocates `HOME` and `CLAUDE_CONFIG_DIR` into `.kiln/` on purpose. Left at
their defaults they would land on the microVM's own disk, outside this mount
and outside the encryption.

## Option 1 — LUKS on a loopback file (recommended)

Self-contained, portable between hosts, and kernel-speed. A loopback file
avoids needing a spare partition.

```bash
# 1. A container file, sized for the repositories you expect
sudo truncate -s 40G /var/lib/kiln-workspaces.img

# 2. Format it. Choose a strong passphrase; you will also add a keyfile below.
sudo cryptsetup luksFormat --type luks2 /var/lib/kiln-workspaces.img

# 3. A keyfile, so the volume can unlock at boot without a human typing
sudo install -m 0600 /dev/null /etc/kiln-workspaces.key
sudo dd if=/dev/urandom of=/etc/kiln-workspaces.key bs=512 count=1
sudo cryptsetup luksAddKey /var/lib/kiln-workspaces.img /etc/kiln-workspaces.key

# 4. Open and make a filesystem
sudo cryptsetup luksOpen --key-file /etc/kiln-workspaces.key \
  /var/lib/kiln-workspaces.img kiln-workspaces
sudo mkfs.ext4 -L kiln-ws /dev/mapper/kiln-workspaces
sudo mkdir -p /mnt/kiln-workspaces
sudo mount /dev/mapper/kiln-workspaces /mnt/kiln-workspaces
```

Persist it across reboots — `/etc/crypttab`:

```
kiln-workspaces  /var/lib/kiln-workspaces.img  /etc/kiln-workspaces.key  luks,nofail
```

and `/etc/fstab`:

```
/dev/mapper/kiln-workspaces  /mnt/kiln-workspaces  ext4  defaults,nofail  0  2
```

Then point Kiln at it:

```bash
export KILN_WORKSPACE_ROOT=/mnt/kiln-workspaces
docker compose --profile forge up -d
```

A keyfile on the same host means an attacker with root on a *running* machine
can read the volume. What this protects against is the disk at rest: a stolen
drive, a decommissioned server, a snapshot copied somewhere it shouldn't be.
If you want unlock-on-boot to require a human, drop the keyfile from
`/etc/crypttab` and unlock manually after each reboot.

## Option 2 — fscrypt (ext4/f2fs native)

No loopback, no second filesystem, per-directory. Good when the host
filesystem already supports it.

```bash
sudo tune2fs -O encrypt /dev/<device>     # once, if not already enabled
sudo fscrypt setup
sudo mkdir -p /mnt/kiln-workspaces
sudo fscrypt encrypt /mnt/kiln-workspaces
```

## Option 3 — ZFS native encryption

If the host already runs ZFS, a dedicated dataset is the least ceremony:

```bash
sudo zfs create -o encryption=on -o keyformat=passphrase tank/kiln-workspaces
sudo zfs set mountpoint=/mnt/kiln-workspaces tank/kiln-workspaces
```

## Not recommended — gocryptfs or other FUSE layers

They work, but sbx passes the workspace into the microVM via filesystem
passthrough (virtiofs). Layering that on top of FUSE is a real performance
trap for a git tree plus `node_modules`; the kernel-level options above avoid
it entirely.

## What encryption here does *not* cover

- **The microVM's own disk** — anything installed outside the workspace, and
  whatever the agent chooses to write to an absolute path elsewhere. Host
  full-disk encryption is the only answer; it is recommended, not required.
- **The sbx daemon's metadata.** Kiln never passes the GitHub token or a
  provider key through sbx's create-time `env` for this reason — those arrive
  over the agent's authenticated loopback port and exist only in VM memory.
- **RAM and swap.** Disable swap, or encrypt it.

## Verifying it

With the volume locked, nothing should be readable:

```bash
sudo umount /mnt/kiln-workspaces
sudo cryptsetup luksClose kiln-workspaces
sudo grep -r "a phrase from one of your chats" /var/lib/kiln-workspaces.img   # no match
```

And confirm no credential reached the daemon's state directory:

```bash
sudo grep -rl "github_pat_" /var/lib/sbx/ 2>/dev/null   # should print nothing
```
