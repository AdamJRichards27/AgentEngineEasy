import assert from "node:assert/strict";
import test from "node:test";
import { createSessionEndedNotice, createSessionExpiryCoordinator } from "../sessionExpiry";

// AE GROW Pilot Readiness WP5 — global session-expiry coordination.

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(signedIn: boolean) {
  const notice = createSessionEndedNotice();
  const log: string[] = [];
  let pending = deferred<"signed-in" | "signed-out">();
  let isSignedIn = signedIn;
  const coordinator = createSessionExpiryCoordinator(
    {
      isSignedIn: () => isSignedIn,
      cancelOtherQueries: () => log.push("cancel"),
      refreshSession: () => {
        log.push("refresh");
        return pending.promise;
      },
    },
    notice,
  );
  return {
    notice,
    log,
    coordinator,
    settle: async (outcome: "signed-in" | "signed-out") => {
      pending.resolve(outcome);
      await new Promise((r) => setTimeout(r, 0));
      pending = deferred();
    },
    setSignedIn: (value: boolean) => (isSignedIn = value),
  };
}

test("a mid-session 401 shows the notice and re-checks the session once", async () => {
  const { notice, log, coordinator, settle, setSignedIn } = setup(true);
  coordinator.handle();
  assert.equal(notice.get(), true);
  assert.deepEqual(log, ["cancel", "refresh"]);
  // A burst of parallel 401s collapses into the one in-flight re-check.
  coordinator.handle();
  coordinator.handle();
  assert.deepEqual(log, ["cancel", "refresh"]);
  setSignedIn(false);
  await settle("signed-out");
  assert.equal(notice.get(), true, "notice stays for the sign-in screen");
  assert.equal(coordinator.isHandling(), false);
  // Once signed out, later 401s do nothing (no redirect / refetch loop).
  coordinator.handle();
  assert.deepEqual(log, ["cancel", "refresh"]);
});

test("a 401 while not signed in (e.g. public pages) does nothing", () => {
  const { notice, log, coordinator } = setup(false);
  coordinator.handle();
  assert.equal(notice.get(), false);
  assert.deepEqual(log, []);
});

test("if the re-check shows the session is still valid, the notice is cleared", async () => {
  const { notice, coordinator, settle } = setup(true);
  coordinator.handle();
  assert.equal(notice.get(), true);
  await settle("signed-in");
  assert.equal(notice.get(), false);
  assert.equal(coordinator.isHandling(), false);
});

test("session-ended notice store notifies subscribers only on change", () => {
  const notice = createSessionEndedNotice();
  let notified = 0;
  const unsubscribe = notice.subscribe(() => notified++);
  notice.set(true);
  notice.set(true);
  notice.set(false);
  assert.equal(notified, 2);
  unsubscribe();
  notice.set(true);
  assert.equal(notified, 2);
});
