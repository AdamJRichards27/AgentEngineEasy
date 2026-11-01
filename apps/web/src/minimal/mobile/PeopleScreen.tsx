import MinimalContacts from "../MinimalContacts";
import MobilePeople from "./MobilePeople";
import { useIsPhone } from "./useIsPhone";

// AE Mobile (CC Task #64, M4): the People page, desktop or phone. Wherever the router renders MinimalContacts
// today, it renders this instead. On a phone it shows the phone list; above 760 px it shows the existing page,
// untouched. Choosing here, not inside MinimalContacts, means the existing page's own queries never run on a
// phone, so nothing is requested twice. Not wired until the wiring pull request is approved.
export default function PeopleScreen() {
  return useIsPhone() ? <MobilePeople /> : <MinimalContacts />;
}
