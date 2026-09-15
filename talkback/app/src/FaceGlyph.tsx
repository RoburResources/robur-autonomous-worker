type Props = {
  size?: number;
  /** 'idle' waits, 'scanning' sweeps, 'ok' settles, 'fail' shakes. */
  phase?: 'idle' | 'scanning' | 'ok' | 'fail';
};

/**
 * Biometric unlock glyph: corner brackets around a face, the convention every
 * platform uses for a face scan. Drawn here rather than borrowed so it carries
 * our own accent colour and animation.
 */
export default function FaceGlyph({ size = 96, phase = 'idle' }: Props) {
  return (
    <div className={`faceglyph faceglyph--${phase}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M8 30V16a8 8 0 0 1 8-8h14" />
          <path d="M70 8h14a8 8 0 0 1 8 8v14" />
          <path d="M92 70v14a8 8 0 0 1-8 8H70" />
          <path d="M30 92H16a8 8 0 0 1-8-8V70" />
        </g>
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="5.5"
          strokeLinecap="round"
          className="faceglyph__face"
        >
          <path d="M35 38v8" />
          <path d="M65 38v8" />
          <path d="M50 38v16l-5 4" />
          <path d="M36 66c4 5 9 7 14 7s10-2 14-7" />
        </g>
      </svg>
      <span className="faceglyph__sweep" />
    </div>
  );
}
