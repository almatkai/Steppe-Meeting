import React from "react";

interface SteppeIconProps extends React.SVGProps<SVGSVGElement> {
  className?: string;
  size?: number | string;
}

/**
 * SteppeIcon: Custom vector brand icon for Steppe Meeting.
 * Features an organic steppe horizon curve that flows into high-fidelity soundwave peaks.
 * Drop-in replacement for generic Sparkles in buttons, badges, and toolbars.
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
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...props}
    >
      {/* Steppe wave motif: Horizon curve on left flowing into dynamic soundwave frequencies */}
      <path d="M2 12c1.5-1.5 3.5-2.5 5.5-2 2 .5 3 2.5 4 2.5l1.5-8.5 2 16 2-13 2 9.5 1.5-5 1.5 0" />
    </svg>
  );
};

/**
 * SteppeLogo: Full application brand emblem for sidebars, headers, and dialogs.
 * Uses the custom generated Steppe Meeting icon asset.
 */
export const SteppeLogo: React.FC<{
  className?: string;
  imgClassName?: string;
}> = ({
  className = "w-9 h-9",
  imgClassName = "w-full h-full rounded-xl object-cover shadow-lg shadow-indigo-600/30 border border-indigo-400/20",
}) => {
  return (
    <div className={`relative flex items-center justify-center shrink-0 ${className}`}>
      <img
        src="/steppe-icon.png"
        alt="Steppe Meeting"
        className={imgClassName}
      />
    </div>
  );
};
