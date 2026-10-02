import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage, apiFetch } from "../lib/api";

// Matches apps/api/src/lib/auth/personName.ts PERSON_NAME_MAX_LENGTH.
const NAME_MAX = 80;

// UAT-OB1 — the signed-in user edits their own first and last name.
// PATCH /auth/profile has no user id; the server updates only the session
// user. This form never sends an id, email, or role.
export default function OwnNameForm({
  initialFirstName,
  initialLastName,
}: {
  initialFirstName: string;
  initialLastName: string;
}) {
  const queryClient = useQueryClient();
  const [firstName, setFirstName] = useState(initialFirstName);
  const [lastName, setLastName] = useState(initialLastName);
  const trimmedFirst = firstName.trim();
  const trimmedLast = lastName.trim();
  const tooLong = trimmedFirst.length > NAME_MAX || trimmedLast.length > NAME_MAX;
  const namesOk = trimmedFirst.length > 0 && trimmedLast.length > 0 && !tooLong;

  const save = useMutation({
    mutationFn: () =>
      apiFetch("/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({ firstName: trimmedFirst, lastName: trimmedLast }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session"] }),
  });

  const submit = () => {
    if (!namesOk || save.isPending) return;
    save.mutate();
  };

  return (
    <div className="stack">
      <label>
        First name
        <input type="text" autoComplete="given-name" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
      </label>
      <label>
        Last name
        <input type="text" autoComplete="family-name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
      </label>
      {tooLong && <p className="error-text">First and last name must be {NAME_MAX} characters or fewer.</p>}
      <button className="btn btn-primary btn-small" onClick={submit} disabled={!namesOk || save.isPending}>
        {save.isPending ? "Saving…" : "Save name"}
      </button>
      {save.isSuccess && <p className="muted">Name saved.</p>}
      {save.isError && <p className="error-text">{apiErrorMessage(save.error, "Couldn't save your name. Try again.")}</p>}
    </div>
  );
}
