// AE GROW Completion W2-D — Contact 360's contact-anchored signal prose.
//
// A signal with a party and no property is a CONTACT-ANCHORED signal: the
// intelligence genuinely relates to the person, and AE has no verified
// property association for it. The API decides that
// (apps/api/src/lib/propertyIntelligence/evaluation.ts's classifySignalAnchor,
// off the rule registry itself); this module only decides how the two honest
// sentences that come with it are worded.
//
// THE RULE THESE FUNCTIONS EXIST TO ENFORCE. The absence of a property is
// represented AS AN ABSENCE. Nothing here produces a property link, a property
// name, a placeholder, or an affordance that would navigate to a property —
// because there is no property, and inventing one to make the panel look
// finished is exactly what the W2-D objective forbids.
//
// The withholding notice deliberately follows lib/growToday.ts's
// signalWithholdingNotice() idiom rather than inventing a second one: a count,
// what it is, and where it still lives. Grow Today already had to solve
// "never let a withheld item just vanish" and this is the same problem on a
// different surface.

/**
 * What the Property Intelligence panel is deliberately NOT showing on this
 * contact, in one sentence, or null when it is showing everything.
 *
 * `unusableSignalCount` is the API's third anchor category: an Active signal
 * for this contact whose rule is ABOUT a property, that arrived without one.
 * AE cannot explain it — the subject of the explanation is missing — so it is
 * not rendered as intelligence. It is also not deleted, and saying nothing
 * about it would be the same silent drop W2-D exists to remove.
 *
 * Phrased as a records problem, never as a judgement about the contact.
 */
export function unusableSignalNotice(unusableSignalCount: number): string | null {
  if (!Number.isFinite(unusableSignalCount) || unusableSignalCount <= 0) return null;
  const isOne = unusableSignalCount === 1;
  return (
    `${unusableSignalCount} other ${isOne ? "signal is" : "signals are"} recorded against this contact but ${isOne ? "is" : "are"} not shown: ` +
    `${isOne ? "it describes" : "they describe"} a property that is no longer linked in AE, so there is nothing ${isOne ? "it" : "they"} can honestly be shown against. ` +
    `Nothing has been deleted — ask a Brokerage Administrator to check the property records.`
  );
}

/**
 * The standing explanation for the contact-anchored section itself.
 *
 * Says what the section is BEFORE the agent reads a signal in it, so a signal
 * with no property never reads as a signal whose property failed to load.
 */
export const CONTACT_ANCHORED_SECTION_BLURB =
  "These relate to this person rather than to a property. AE has no property linked to them, so there is no property to open and no property action to take — the evidence and the gaps are below.";
