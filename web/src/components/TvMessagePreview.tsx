import type { CSSProperties } from 'react';
import type { MessageIcon, PreviewMessage } from '../../../src/enforce/message-catalog';
// The channel's own artwork, so the preview looks like the TV.
import background from '../../../roku-channel/images/background.jpg';
import blocked from '../../../roku-channel/art/icon-blocked.svg';
import budget from '../../../roku-channel/art/icon-budget.svg';
import info from '../../../roku-channel/art/icon-info.svg';
import lock from '../../../roku-channel/art/icon-lock.svg';
import message from '../../../roku-channel/art/icon-message.svg';
import schedule from '../../../roku-channel/art/icon-schedule.svg';
import warning from '../../../roku-channel/art/icon-warning.svg';

const ICONS: Record<MessageIcon, string> = { blocked, budget, info, lock, message, schedule, warning };

/**
 * The Parental Control channel's screen in miniature (roku-channel/components/MessageScene.xml):
 * the same artwork, colours and proportions of a 1920×1080 screen, sized with container units.
 * Text has a minimum size so it stays readable on a phone, so line breaks can differ a little.
 */
const cq = (px: number, min = 0): string =>
  min ? `max(${min}px, ${(px / 19.2).toFixed(2)}cqw)` : `${(px / 19.2).toFixed(2)}cqw`;

export function TvMessagePreview({ message: m }: { message: PreviewMessage }) {
  const style: CSSProperties = { backgroundImage: `url(${background})`, backgroundSize: 'cover' };
  return (
    <div className="[container-type:inline-size]">
      <div
        role="img"
        aria-label={`On the TV: ${m.title}. ${m.body} ${m.countdown}`}
        className="relative aspect-video overflow-hidden rounded-2xl bg-[#0b1022] shadow-[0_0_0_6px_#05070f,0_10px_30px_rgba(5,7,15,0.35)]"
        style={style}
      >
        <div
          className="absolute inset-0 flex flex-col justify-center"
          style={{ paddingLeft: cq(200), paddingRight: cq(160), paddingBottom: cq(60) }}
        >
          <img src={ICONS[m.icon]} alt="" style={{ width: cq(176), height: cq(176), marginBottom: cq(48) }} />
          <p
            className="line-clamp-2 font-semibold text-[#eef1f8]"
            style={{ fontSize: cq(92, 15), lineHeight: 1.12, maxWidth: cq(1500) }}
          >
            {m.title}
          </p>
          {m.body && (
            <p
              className="line-clamp-4 whitespace-pre-line text-[#a3abc4]"
              style={{ fontSize: cq(46, 10), lineHeight: 1.38, maxWidth: cq(1240), marginTop: cq(28) }}
            >
              {m.body}
            </p>
          )}
          {m.countdown && (
            <div style={{ marginTop: cq(64) }}>
              <p className="font-medium text-[#eef1f8]" style={{ fontSize: cq(42, 9) }}>
                {m.countdown}
              </p>
              <div className="bg-[#2b2763]" style={{ marginTop: cq(24), height: cq(10, 2), width: cq(1000) }}>
                <div className="h-full w-[62%] bg-[#a494ff]" />
              </div>
            </div>
          )}
        </div>
        <span
          className="absolute font-medium text-[#737c99]"
          style={{ left: cq(200), bottom: cq(98), fontSize: cq(30, 8) }}
        >
          Parental Control
        </span>
        {m.dismissable && (
          <span className="absolute text-[#a3abc4]" style={{ right: cq(200), bottom: cq(98), fontSize: cq(30, 8) }}>
            Press OK to close
          </span>
        )}
      </div>
    </div>
  );
}
