export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true" focusable="false">
      <rect x="4" y="4" width="120" height="120" rx="26" fill="#080A12" />
      <rect
        x="4.75"
        y="4.75"
        width="118.5"
        height="118.5"
        rx="25.25"
        fill="none"
        stroke="#00F5FF"
        strokeOpacity=".55"
        strokeWidth="1.5"
      />
      <path
        d="M40 26h48l22 22v32L88 102H40L18 80V48z"
        fill="none"
        stroke="#FF2BD6"
        strokeOpacity=".7"
        strokeWidth="3"
        transform="translate(3 3)"
      />
      <path d="M40 26h48l22 22v32L88 102H40L18 80V48z" fill="#101522" stroke="#00F5FF" strokeWidth="3" />
      <path
        d="M64 40v34M48 62l16 16 16-16"
        fill="none"
        stroke="#F2F5FF"
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M44 90h40" stroke="#B7FF3C" strokeWidth="6" strokeLinecap="round" />
    </svg>
  );
}
