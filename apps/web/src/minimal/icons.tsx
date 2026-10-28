import type { ReactNode, SVGProps } from "react";

// Original stroke icons for the empty shell. No icon package.

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function MinimalNavIcon({ path }: { path: string }) {
  switch (path) {
    case "/grow":
      return (
        <Svg>
          <path d="M12 21V10" />
          <path d="M12 14c-3-1-5-4-5-7 3 0 5 2 5 4" />
          <path d="M12 12c3-1 5-4 5-7-3 0-5 2-5 4" />
        </Svg>
      );
    case "/":
      return (
        <Svg>
          <path d="M4 11 12 4l8 7" />
          <path d="M6 10v10h12V10" />
        </Svg>
      );
    case "/today":
      return (
        <Svg>
          <rect x="4" y="5" width="16" height="15" rx="2" />
          <path d="M8 3v4M16 3v4M4 10h16" />
        </Svg>
      );
    case "/properties":
    case "/properties/start":
      return (
        <Svg>
          <path d="M4 20V9l8-5 8 5v11" />
          <path d="M10 20v-6h4v6" />
        </Svg>
      );
    case "/exceptions":
      return (
        <Svg>
          <path d="M12 4 21 19H3Z" />
          <path d="M12 10v4M12 16.5v.5" />
        </Svg>
      );
    case "/communications":
      return (
        <Svg>
          <path d="M5 6h14v10H8l-3 3z" />
        </Svg>
      );
    case "/financial":
      return (
        <Svg>
          <rect x="3" y="6" width="18" height="12" rx="2" />
          <path d="M3 10h18" />
        </Svg>
      );
    case "/pit-crew":
      return (
        <Svg>
          <circle cx="9" cy="9" r="3" />
          <circle cx="16" cy="10" r="2.4" />
          <path d="M4 19c1-3 3-4 5-4s4 1 5 4" />
          <path d="M14 19c.4-2 1.5-3 3-3 1.2 0 2 .6 2.6 2" />
        </Svg>
      );
    case "/settings":
      return (
        <Svg>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
        </Svg>
      );
    case "/owner":
      return (
        <Svg>
          <path d="M12 3l7 3v6c0 5-3 7-7 9-4-2-7-4-7-9V6z" />
        </Svg>
      );
    case "/grow?tab=contacts":
      return (
        <Svg>
          <circle cx="9" cy="8" r="3" />
          <path d="M3 20c1-4 3.5-5 6-5s5 1 6 5" />
          <path d="M16 5a3 3 0 0 1 0 6M18 15c1.5.6 2.5 2 3 5" />
        </Svg>
      );
    case "/grow/opportunities":
      return (
        <Svg>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="12" cy="12" r=".6" />
        </Svg>
      );
    case "/grow/appraisals":
      return (
        <Svg>
          <path d="M7 3h7l4 4v14H7z" />
          <path d="M14 3v4h4M10 13h5M10 17h5" />
        </Svg>
      );
    case "/grow/market-activity":
      return (
        <Svg>
          <path d="M4 19h16" />
          <path d="m5 15 4-4 3 3 6-7" />
        </Svg>
      );
    case "/grow/momentum":
      return (
        <Svg>
          <path d="M13 3 5 14h6l-1 7 8-11h-6z" />
        </Svg>
      );
    case "marketing":
    case "/grow/marketing":
      return (
        <Svg>
          <path d="M4 10v4l11 5V5z" />
          <path d="M15 9a3 3 0 0 1 0 6" />
        </Svg>
      );
    default:
      return (
        <Svg>
          <circle cx="12" cy="12" r="2" />
        </Svg>
      );
  }
}

/** V1 grouped sidebar: icon by link href (or a named placeholder icon). */
export function MinimalSidebarIcon({ name }: { name: string }) {
  return <MinimalNavIcon path={name} />;
}
