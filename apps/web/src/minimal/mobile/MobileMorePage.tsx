import "./mobile.css";
import { MobileMoreView } from "./MobileMoreView";
import { useMobileNav } from "./useMobileNav";

// AE Mobile (CC Task #64, M2): the /more page. The container: it builds the phone navigation and
// hands it to MobileMoreView. Not wired into any route until the wiring pull request is approved.
export default function MobileMorePage() {
  return <MobileMoreView nav={useMobileNav()} />;
}
