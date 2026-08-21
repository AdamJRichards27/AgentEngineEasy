// Agent Engine logo, white wordmark — for the dark sidebar background.
// The base64 payload is split across logoSidebarPart0..4 (small chunks) so
// each chunk can be pushed and verified reliably without risking silent
// truncation or transcription corruption on one giant string.
import { LOGO_SIDEBAR_PART_0 } from "./logoSidebarPart0";
import { LOGO_SIDEBAR_PART_1 } from "./logoSidebarPart1";
import { LOGO_SIDEBAR_PART_2 } from "./logoSidebarPart2";
import { LOGO_SIDEBAR_PART_3 } from "./logoSidebarPart3";
import { LOGO_SIDEBAR_PART_4 } from "./logoSidebarPart4";

export const LOGO_SIDEBAR =
  "data:image/png;base64," +
  LOGO_SIDEBAR_PART_0 +
  LOGO_SIDEBAR_PART_1 +
  LOGO_SIDEBAR_PART_2 +
  LOGO_SIDEBAR_PART_3 +
  LOGO_SIDEBAR_PART_4;
