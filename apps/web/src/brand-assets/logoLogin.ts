// Agent Engine logo, dark-gray wordmark — for the light auth-card background.
// The base64 payload is split across logoLoginPart0..4 (small chunks) so
// each chunk can be pushed and verified reliably without risking silent
// truncation or transcription corruption on one giant string.
import { LOGO_LOGIN_PART_0 } from "./logoLoginPart0";
import { LOGO_LOGIN_PART_1 } from "./logoLoginPart1";
import { LOGO_LOGIN_PART_2 } from "./logoLoginPart2";
import { LOGO_LOGIN_PART_3 } from "./logoLoginPart3";
import { LOGO_LOGIN_PART_4 } from "./logoLoginPart4";

export const LOGO_LOGIN =
  "data:image/png;base64," +
  LOGO_LOGIN_PART_0 +
  LOGO_LOGIN_PART_1 +
  LOGO_LOGIN_PART_2 +
  LOGO_LOGIN_PART_3 +
  LOGO_LOGIN_PART_4;
