import { describe, expect, it } from 'vitest';
import { EcpParseError, parseActiveApp, parseApps, parseDeviceInfo, parseMediaPlayer } from '../../src/ecp/xml.js';

describe('parseDeviceInfo', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<device-info>
  <udn>28001240-0000-1000-8000-d8313400beef</udn>
  <serial-number>X01900ABCDEF</serial-number>
  <device-id>S0A12345678</device-id>
  <vendor-name>TCL</vendor-name>
  <model-name>55S455</model-name>
  <model-number>C135X</model-number>
  <friendly-model-name>TCL•Roku TV</friendly-model-name>
  <is-tv>true</is-tv>
  <wifi-mac>D8:31:34:AA:BB:CC</wifi-mac>
  <ethernet-mac>00:00:00:00:00:00</ethernet-mac>
  <friendly-device-name>Living Room</friendly-device-name>
  <default-device-name>TCL•Roku TV - X01900ABCDEF</default-device-name>
  <user-device-name>Kids TV</user-device-name>
  <software-version>14.1.4</software-version>
  <power-mode>DisplayOff</power-mode>
  <developer-enabled>false</developer-enabled>
</device-info>`;

  it('extracts identity, power and MACs', () => {
    const info = parseDeviceInfo(xml);
    expect(info.serialNumber).toBe('X01900ABCDEF');
    expect(info.name).toBe('Kids TV'); // user-device-name wins
    expect(info.modelName).toBe('TCL•Roku TV');
    expect(info.powerMode).toBe('DisplayOff');
    expect(info.isTv).toBe(true);
    expect(info.developerEnabled).toBe(false);
    expect(info.macs).toEqual(['d8:31:34:aa:bb:cc']); // all-zero ethernet MAC dropped
    expect(info.raw['udn']).toBe('28001240-0000-1000-8000-d8313400beef');
  });

  it('falls back through name fields and tolerates missing serial', () => {
    const info = parseDeviceInfo(
      '<device-info><model-name>Roku Ultra</model-name><power-mode>PowerOn</power-mode></device-info>',
    );
    expect(info.name).toBe('Roku Ultra');
    expect(info.serialNumber).toBeNull();
    expect(info.macs).toEqual([]);
  });

  it('decodes XML entities', () => {
    expect(
      parseDeviceInfo('<device-info><user-device-name>Tom &amp; Jerry&apos;s</user-device-name></device-info>').name,
    ).toBe("Tom & Jerry's");
  });

  it('rejects the wrong root element', () => {
    expect(() => parseDeviceInfo('<apps></apps>')).toThrow(EcpParseError);
  });
});

describe('parseActiveApp', () => {
  it('reports Home as app=null (classic <app>Roku</app>)', () => {
    const a = parseActiveApp('<active-app><app>Roku</app></active-app>');
    expect(a.app).toBeNull();
    expect(a.screensaver).toBeNull();
  });

  it('treats an explicit home/menu type as Home', () => {
    expect(parseActiveApp('<active-app><app id="562859" type="home">Home</app></active-app>').app).toBeNull();
    expect(parseActiveApp('<active-app><app id="1" type="menu">Home</app></active-app>').app).toBeNull();
  });

  it('parses a channel', () => {
    const a = parseActiveApp('<active-app><app id="12" type="appl" version="4.1.218">Netflix</app></active-app>');
    expect(a.app).toEqual({ id: '12', name: 'Netflix', type: 'appl', version: '4.1.218' });
  });

  it('parses a TV input as an app', () => {
    const a = parseActiveApp('<active-app><app id="tvinput.hdmi1" type="tvin" version="1.0.0">Xbox</app></active-app>');
    expect(a.app?.id).toBe('tvinput.hdmi1');
    expect(a.app?.type).toBe('tvin');
  });

  it('parses a screensaver on top of Home or an app', () => {
    const home = parseActiveApp(
      '<active-app><app>Roku</app><screensaver id="55545" type="ssvr" version="2.0.1">Default screensaver</screensaver></active-app>',
    );
    expect(home.app).toBeNull();
    expect(home.screensaver).toEqual({ id: '55545', name: 'Default screensaver', type: 'ssvr', version: '2.0.1' });

    const overApp = parseActiveApp(
      '<active-app><app id="837" type="appl">YouTube</app><screensaver id="5" type="ssvr">Aquarium</screensaver></active-app>',
    );
    expect(overApp.app?.id).toBe('837');
    expect(overApp.screensaver?.name).toBe('Aquarium');
  });
});

describe('parseApps', () => {
  it('parses a list, including inputs', () => {
    const apps = parseApps(`<apps>
      <app id="31012" type="menu" version="1.0.0">FandangoNOW Movies &amp; TV</app>
      <app id="tvinput.hdmi1" type="tvin" version="1.0.0">HDMI 1</app>
      <app id="12" subtype="ndka" type="appl" version="5.2.83">Netflix</app>
    </apps>`);
    expect(apps.map((a) => a.id)).toEqual(['31012', 'tvinput.hdmi1', '12']);
    expect(apps[0]!.name).toBe('FandangoNOW Movies & TV');
  });

  it('handles a single app (array coercion) and an empty list', () => {
    expect(parseApps('<apps><app id="12" type="appl">Netflix</app></apps>')).toHaveLength(1);
    expect(parseApps('<apps/>')).toEqual([]);
    expect(parseApps('<apps></apps>')).toEqual([]);
  });
});

describe('parseMediaPlayer', () => {
  it('parses a playing state', () => {
    const p = parseMediaPlayer(`<player error="false" state="play">
      <plugin bandwidth="18000000 bps" id="12" name="Netflix"/>
      <format audio="aac" video="mpeg4_15"/>
      <position>6916 ms</position>
      <duration>887999 ms</duration>
      <is_live>false</is_live>
    </player>`);
    expect(p).toMatchObject({
      state: 'play',
      error: false,
      pluginId: '12',
      pluginName: 'Netflix',
      positionMs: 6916,
      durationMs: 887999,
      isLive: false,
    });
  });

  it('parses an idle player', () => {
    expect(parseMediaPlayer('<player error="false" state="close"/>')).toMatchObject({
      state: 'close',
      pluginId: null,
      positionMs: null,
    });
  });

  it('throws EcpParseError on garbage', () => {
    expect(() => parseMediaPlayer('not xml at all')).toThrow(EcpParseError);
  });
});
