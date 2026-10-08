import { useEffect, useRef, useState } from 'react';
import { api, type ActionResultDto, type SettingsDto } from '../api';
import { TvMessagePreview } from '../components/TvMessagePreview';
import { Banner, Button, Icon, Section, useToast } from '../components/ui';
import { useApi } from '../hooks';
import {
  CATALOG,
  CATALOG_BY_KEY,
  GROUPS,
  PLACEHOLDER_HELP,
  compactTexts,
  previewMessage,
  textFor,
  textProblems,
  type MessageEntry,
  type MessageField,
  type MessageKey,
  type Placeholder,
  type TvTexts,
} from '../../../src/enforce/message-catalog';

/**
 * Settings → TV messages → "What the TV says": every message the channel can show, rewritable.
 * #/settings/messages lists them by situation; #/settings/messages/<key> edits one, with a live
 * preview of the TV screen. Saved into the tvMessages settings section (texts).
 */
export function MessagesView({ messageKey }: { messageKey: string | null }) {
  const s = useApi<SettingsDto>('/api/settings');
  if (!s.data) return <p className="py-24 text-center text-muted">Loading…</p>;

  // A service older than this page doesn't know about rewritten messages yet.
  if (s.data.tvMessages.texts === undefined) {
    return (
      <div>
        <BackLink href="#/settings" label="Settings" />
        <h1 className="mb-4 text-3xl font-semibold tracking-tight">What the TV says</h1>
        <Banner tone="info" icon="settings">
          <p className="font-medium">Restart Roku TV Parental Control to edit the messages.</p>
          <p className="mt-1 text-sm text-muted">
            On the PC, in an administrator terminal: <code>npm run build</code>, then{' '}
            <code>npm run service:restart</code>.
          </p>
        </Banner>
      </div>
    );
  }

  const key = messageKey && messageKey in CATALOG_BY_KEY ? (messageKey as MessageKey) : null;
  return key ? (
    <MessageEditor key={key} entry={CATALOG_BY_KEY[key]} settings={s.data} onSaved={s.setData} />
  ) : (
    <MessageList texts={s.data.tvMessages.texts} />
  );
}

function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} className="-ml-1 mb-3 inline-flex min-h-10 items-center gap-1 text-[15px] text-accent">
      <Icon name="back" size={18} />
      {label}
    </a>
  );
}

/** One line that shows the message's current words, with the example values. */
function summary(entry: MessageEntry, texts: TvTexts): string {
  const p = previewMessage(entry.key, texts);
  if (entry.key === 'countdown_off' || entry.key === 'countdown_back') return p.countdown;
  if (entry.key === 'parent') return p.body || textFor(texts, 'parent', 'longTitle');
  return p.title;
}

function MessageList({ texts }: { texts: TvTexts }) {
  const changed = new Set(Object.keys(compactTexts(texts)));
  return (
    <div className="pb-8">
      <BackLink href="#/settings" label="Settings" />
      <h1 className="mb-2 text-3xl font-semibold tracking-tight">What the TV says</h1>
      <p className="mb-2 max-w-prose text-[15px] text-muted">
        Rewrite any message the TV shows. Words in braces, like {'{app}'}, are filled in for you.
      </p>
      {GROUPS.map((g) => (
        <Section key={g.id} title={g.title} description={g.description}>
          <ul className="divide-y divide-line">
            {CATALOG.filter((e) => e.group === g.id).map((e) => (
              <li key={e.key}>
                <a href={`#/settings/messages/${e.key}`} className="flex min-h-16 items-center gap-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-[15px]">
                      {e.name}
                      {changed.has(e.key) && (
                        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
                          Changed
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-sm text-muted">{summary(e, texts)}</span>
                  </span>
                  <Icon name="chevron" className="shrink-0 text-faint" />
                </a>
              </li>
            ))}
          </ul>
        </Section>
      ))}
      <p className="text-sm text-faint">
        “Press OK to close” and the channel’s name stay as they are. Changes apply the next time a message is shown.
      </p>
    </div>
  );
}

function MessageEditor({
  entry,
  settings,
  onSaved,
}: {
  entry: MessageEntry;
  settings: SettingsDto;
  onSaved: (s: SettingsDto) => void;
}) {
  const toast = useToast();
  const saved = settings.tvMessages.texts;
  const wordsFrom = (texts: TvTexts | undefined): Record<string, string> =>
    Object.fromEntries(entry.fields.map((f) => [f.id, textFor(texts, entry.key, f.id)]));
  const [values, setValues] = useState<Record<string, string>>(() => wordsFrom(saved));
  const [busy, setBusy] = useState<'save' | 'tv' | null>(null);
  const refs = useRef<Record<string, HTMLInputElement | HTMLTextAreaElement | null>>({});
  const lastField = useRef<string>(entry.fields[0]!.id);

  // After a save (or a reload), start again from what's stored.
  useEffect(() => setValues(wordsFrom(saved)), [saved]);

  const draft: TvTexts = { ...saved, [entry.key]: values };
  const problems = Object.fromEntries(entry.fields.map((f) => [f.id, textProblems(entry, f, values[f.id] ?? '')]));
  const invalid = Object.values(problems).some((p) => p.length > 0);
  const mine = (t: TvTexts) => JSON.stringify(compactTexts(t)[entry.key] ?? null);
  const dirty = mine(draft) !== mine(saved);
  const original = mine(draft) === 'null';

  const insert = (p: Placeholder): void => {
    const id = lastField.current;
    const el = refs.current[id];
    const current = values[id] ?? '';
    const token = `{${p}}`;
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const before = current.slice(0, start);
    const after = current.slice(end);
    // Keep words apart: a space before unless at the start, after unless punctuation follows.
    const spaced =
      (before && !/\s$/.test(before) ? ' ' : '') + token + (after && !/^[\s.,!?;:…]/.test(after) ? ' ' : '');
    setValues((v) => ({ ...v, [id]: before + spaced + after }));
    requestAnimationFrame(() => {
      el?.focus();
      const caret = start + spaced.length;
      el?.setSelectionRange(caret, caret);
    });
  };

  const save = async (): Promise<void> => {
    setBusy('save');
    try {
      const { installed: _i, installedVersion: _v, packageVersion: _p, ...section } = settings.tvMessages;
      const next = await api.put<SettingsDto>('/api/settings/tvMessages', { ...section, texts: compactTexts(draft) });
      onSaved(next);
      toast('Saved. The TV uses these words from now on.');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const showOnTv = async (): Promise<void> => {
    setBusy('tv');
    try {
      toast(
        (await api.post<ActionResultDto>('/api/tv-messages/preview', { key: entry.key, texts: compactTexts(draft) }))
          .message,
      );
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pb-8">
      <BackLink href="#/settings/messages" label="What the TV says" />
      <h1 className="mb-1 text-3xl font-semibold tracking-tight">{entry.name}</h1>
      <p className="mb-5 text-[15px] text-muted">{entry.when}</p>

      <TvMessagePreview message={previewMessage(entry.key, draft)} />
      <p className="mt-3 mb-5 text-sm text-muted">
        {Object.keys(entry.samples).length
          ? 'With example words filled in. Line breaks on the TV can differ a little.'
          : 'Line breaks on the TV can differ a little.'}
      </p>

      {entry.fields.map((f) => (
        <TemplateField
          key={f.id}
          field={f}
          value={values[f.id] ?? ''}
          problems={problems[f.id] ?? []}
          inputRef={(el) => void (refs.current[f.id] = el)}
          onFocus={() => (lastField.current = f.id)}
          onChange={(v) => setValues((x) => ({ ...x, [f.id]: v }))}
        />
      ))}

      {entry.placeholders.length > 0 && (
        <div className="mt-2 mb-6">
          <p className="mb-2 text-sm text-muted">Words Roku TV Parental Control fills in. Tap one to add it.</p>
          <ul className="flex flex-col gap-1.5">
            {entry.placeholders.map((p) => (
              <li key={p}>
                <button
                  type="button"
                  onPointerDown={(e) => e.preventDefault()} // keep the cursor where it is
                  onClick={() => insert(p)}
                  className="flex min-h-11 w-full items-center gap-3 rounded-xl bg-raised px-3 text-left hover:bg-accent-soft"
                >
                  <code className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-sm text-accent">{`{${p}}`}</code>
                  <span className="min-w-0 text-sm text-muted">
                    {PLACEHOLDER_HELP[p]}
                    {entry.samples[p] && <span className="text-faint">, like “{entry.samples[p]}”</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!dirty || invalid} busy={busy === 'save'} onClick={save}>
          Save
        </Button>
        <Button icon="tv" disabled={invalid || !settings.tvMessages.installed} busy={busy === 'tv'} onClick={showOnTv}>
          Show on the TV
        </Button>
      </div>
      {!settings.tvMessages.installed && (
        <p className="mt-2 text-sm text-muted">
          “Show on the TV” works once the Parental Control channel is installed.
        </p>
      )}
      {!original && (
        <button
          type="button"
          className="mt-4 min-h-10 text-[15px] text-accent underline underline-offset-2"
          onClick={() => setValues(wordsFrom(undefined))}
        >
          Use the original words
        </button>
      )}
    </div>
  );
}

function TemplateField({
  field,
  value,
  problems,
  onChange,
  onFocus,
  inputRef,
}: {
  field: MessageField;
  value: string;
  problems: string[];
  onChange: (v: string) => void;
  onFocus: () => void;
  inputRef: (el: HTMLInputElement | HTMLTextAreaElement | null) => void;
}) {
  const id = `field-${field.id}`;
  const cls = `w-full rounded-xl border bg-surface px-4 text-[15px] placeholder:text-faint focus:outline-none ${
    problems.length ? 'border-critical' : 'border-line focus:border-accent'
  }`;
  const common = {
    id,
    value,
    onFocus,
    'aria-invalid': problems.length > 0,
    'aria-describedby': `${id}-note`,
    placeholder: field.required ? undefined : 'Nothing',
  };
  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1 block text-sm text-muted">
        {field.label}
      </label>
      {field.multiline ? (
        <textarea
          {...common}
          ref={inputRef}
          rows={4}
          onChange={(e) => onChange(e.target.value)}
          className={`${cls} block resize-none py-3 leading-snug`}
        />
      ) : (
        <input {...common} ref={inputRef} onChange={(e) => onChange(e.target.value)} className={`${cls} min-h-12`} />
      )}
      <div id={`${id}-note`} className="mt-1 flex justify-between gap-3 text-sm">
        <span className="text-critical">{problems.join(' ')}</span>
        <span className={`tabular shrink-0 ${value.length > field.max ? 'text-critical' : 'text-faint'}`}>
          {value.length}/{field.max}
        </span>
      </div>
      {field.multiline && (
        <p className="-mt-0.5 text-sm text-faint">A new line on the TV starts where you press Enter.</p>
      )}
    </div>
  );
}
