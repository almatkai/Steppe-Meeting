import React, { useId } from "react";

interface SteppeIconProps extends React.SVGProps<SVGSVGElement> {
  className?: string;
  size?: number | string;
}

/**
 * SteppeIcon — small inline stroke mark for buttons / badges / spinners.
 * Audio bars + steppe horizon, inherits currentColor. Crisp at 12–20px.
 */
export const SteppeIcon: React.FC<SteppeIconProps> = ({
  className = "w-4 h-4",
  size,
  ...props
}) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M6 10v4" />
      <path d="M10 7.5v9" />
      <path d="M14 4.5v15" />
      <path d="M18 8.5v7" />
      <path d="M3.5 18.5c2.8-1.6 6-1.6 8.5-0.6 2.6 1 5.5 1 8.5-0.4" strokeWidth={1.7} opacity={0.75} />
    </svg>
  );
};

/**
 * SteppeLogo — full app emblem. Pure vector, no PNG.
 * Deep indigo→sky squircle, white audio bars, cyan steppe horizon.
 * Sharp at 32px sidebar and at 512px splash.
 */
export const SteppeLogo: React.FC<{
  className?: string;
}> = ({ className = "w-9 h-9" }) => {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const bgId = `steppe-bg-${uid}`;
  const glossId = `steppe-gloss-${uid}`;

  return (
    <svg
      viewBox="0 0 48 48"
      className={`${className} shrink-0 drop-shadow-[0_4px_12px_rgba(79,70,229,0.45)]`}
      role="img"
      aria-label="Steppe Meeting"
    >
      <defs>
        <linearGradient id={bgId} x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#818CF8" />
          <stop offset="0.45" stopColor="#4F46E5" />
          <stop offset="1" stopColor="#0EA5E9" />
        </linearGradient>
        <linearGradient id={glossId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.28" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* squircle base */}
      <rect x="1" y="1" width="46" height="46" rx="13" fill={`url(#${bgId})`} />
      {/* top gloss */}
      <rect x="1" y="1" width="46" height="24" rx="13" fill={`url(#${glossId})`} />
      {/* inner border */}
      <rect
        x="1.5"
        y="1.5"
        width="45"
        height="45"
        rx="12"
        fill="none"
        stroke="#FFFFFF"
        strokeOpacity="0.22"
        strokeWidth="1"
      />

      {/* audio bars */}
      <g fill="#FFFFFF">
        <rect x="8.5" y="20" width="4" height="7" rx="2" opacity="0.82" />
        <rect x="14.5" y="17" width="4" height="12" rx="2" opacity="0.92" />
        <rect x="21" y="13" width="4.4" height="17" rx="2.2" />
        <rect x="27.6" y="17" width="4" height="12" rx="2" opacity="0.92" />
        <rect x="34" y="20" width="4" height="7" rx="2" opacity="0.82" />
      </g>

      {/* steppe horizon */}
      <path
        d="M7 35.5 Q24 31.5 41 35.5"
        fill="none"
        stroke="#7DD3FC"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.95"
      />
    </svg>
  );
};
