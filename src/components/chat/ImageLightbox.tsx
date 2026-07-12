/** Full-screen viewer for a generated image, with a download action. */
export function ImageLightbox({
  src,
  onClose,
}: {
  src: string | null
  onClose: () => void
}) {
  if (!src) return null
  return (
    <button
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
    >
      <img src={src} alt="Full size" className="max-h-full max-w-full rounded-xl" />
      <a
        href={src}
        download="kiln-image.png"
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-8 rounded-full bg-white/90 px-4 py-2 text-[13px] font-medium text-black"
      >
        Download
      </a>
    </button>
  )
}
