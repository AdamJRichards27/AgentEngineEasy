import MinimalContact360 from "../MinimalContact360";
import MobileContact from "./MobileContact";
import { useIsPhone } from "./useIsPhone";

// AE Mobile (CC Task #64, M4): Contact 360, desktop or phone. Wherever the router renders MinimalContact360
// today, it renders this instead. On a phone it shows the phone screen; above 760 px it shows the existing
// read-only page, untouched. Not wired until the wiring pull request is approved.
export default function ContactScreen() {
  return useIsPhone() ? <MobileContact /> : <MinimalContact360 />;
}
