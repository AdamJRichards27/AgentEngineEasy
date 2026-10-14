// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

export function GrowListSearch({
  id,
  label,
  placeholder,
  text,
  onText,
  onCommit,
}: {
  id: string;
  label: string;
  placeholder: string;
  text: string;
  onText: (value: string) => void;
  onCommit: () => void;
}) {
  return (
    <form
      className="grow-inline-form-row"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onCommit();
      }}
    >
      <label className="grow-list-filter" htmlFor={id}>
        {label}
        <input
          id={id}
          type="search"
          value={text}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(event) => onText(event.target.value)}
        />
      </label>
    </form>
  );
}
