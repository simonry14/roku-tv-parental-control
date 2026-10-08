import type { ReactElement } from 'react';
import type { StatusDto } from '../api';
import { clock } from '../format';
import { Icon } from './ui';

/**
 * The hero: a small television showing what the real one is showing. The channel tile sits on
 * the glass with a soft glow of its own colours; off = dark glass; no signal = static.
 * The glass stays dark in both themes, like a real screen.
 */
export function TvScreen({ status }: { status: StatusDto }) {
  const { health, current, override, tv } = status;
  const tz = status.timezone;
  let content: ReactElement;
  let caption: string;

  const locked = override?.kind === 'lock';
  if (health.state === 'restricted') {
    content = (
      <div className="static-noise absolute inset-0 grid place-items-center">
        <div className="flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-sm text-white">
          <Icon name="warning" size={18} className="text-[#ff8a8a]" />
          Control blocked
        </div>
      </div>
    );
    caption = 'The TV is refusing commands';
  } else if (health.state === 'offline' || health.state === 'searching' || health.state === 'starting') {
    content = (
      <div className="static-noise absolute inset-0 grid place-items-center opacity-70">
        <span className="rounded-full bg-black/70 px-4 py-2 text-sm text-white">
          {health.state === 'starting' ? 'Connecting…' : 'No signal'}
        </span>
      </div>
    );
    caption =
      health.state === 'searching'
        ? 'Looking for the TV'
        : health.state === 'starting'
          ? 'Connecting'
          : 'Can’t reach the TV';
  } else if (health.state === 'tv_off' || !current) {
    content = (
      <div className="absolute inset-0 grid place-items-center">
        <div className="absolute inset-0 bg-[linear-gradient(115deg,transparent_40%,rgba(255,255,255,.06)_48%,transparent_56%)]" />
        {locked && (
          <span className="flex items-center gap-2 text-sm text-white/70">
            <Icon name="lock" size={18} /> Locked
          </span>
        )}
      </div>
    );
    caption = locked ? 'TV is off and locked' : 'TV is off';
  } else if (status.tvMessages.showing) {
    // Our own channel is on screen: draw a message card rather than the channel's tile.
    content = (
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_10%_110%,rgba(90,71,224,.55),transparent_65%),linear-gradient(#0b1022,#151b38)]">
        <div className="absolute top-[24%] left-[9%] flex flex-col items-start gap-2">
          <span className="grid size-8 place-items-center rounded-full bg-[#2b2763] text-[#c9c0ff]">
            <Icon name="message" size={18} />
          </span>
          <span className="h-2.5 w-40 rounded-full bg-[#eef1f8]/90" />
          <span className="h-2 w-28 rounded-full bg-[#a3abc4]/60" />
          {status.tvMessages.countdown && <span className="mt-2 h-1 w-32 rounded-full bg-[#a494ff]" />}
        </div>
      </div>
    );
    caption = status.tvMessages.countdown ? `“${status.tvMessages.countdown.title}”` : 'Showing a message';
  } else if (current.kind === 'app' && current.iconUrl) {
    content = (
      <>
        <img
          src={current.iconUrl}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 size-full scale-125 object-cover opacity-60 blur-2xl saturate-150"
        />
        <div className="absolute inset-0 bg-black/25" />
        <img
          src={current.iconUrl}
          alt=""
          className="absolute top-1/2 left-1/2 w-[46%] -translate-x-1/2 -translate-y-1/2 rounded-xl shadow-[0_8px_30px_rgba(0,0,0,.45)]"
        />
      </>
    );
    caption = current.appName;
  } else {
    content = (
      <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(ellipse_at_50%_40%,#2a2350,transparent_70%)]">
        <span className="flex items-center gap-2 text-lg text-white/80">
          <Icon name={current.kind === 'home' ? 'home' : 'moon'} size={22} />
          {current.kind === 'home' ? 'Home screen' : 'Screensaver'}
        </span>
      </div>
    );
    caption = current.kind === 'home' ? 'Home screen' : 'Screensaver';
  }

  const since = current && health.state === 'online' ? `since ${clock(current.since, tz)}` : null;

  return (
    <figure className="m-0">
      <div className="mx-auto w-full max-w-[520px]">
        <div className="rounded-[22px] bg-bezel p-[7px] shadow-[0_18px_40px_-18px_rgba(10,14,40,.55)]">
          <div
            className="relative aspect-video overflow-hidden rounded-[16px] bg-screen"
            role="img"
            aria-label={`${tv?.name ?? 'TV'}: ${caption}`}
          >
            {content}
          </div>
        </div>
        {/* stand */}
        <div aria-hidden="true" className="mx-auto h-3 w-2 bg-bezel" />
        <div aria-hidden="true" className="mx-auto h-1.5 w-24 rounded-full bg-bezel" />
      </div>
      <figcaption className="mt-4 text-center">
        <span className="block text-2xl font-semibold tracking-tight">{caption}</span>
        <span className="block text-[15px] text-muted">
          {tv?.name ?? 'Roku TV'}
          {since ? `, ${since}` : ''}
        </span>
      </figcaption>
    </figure>
  );
}
