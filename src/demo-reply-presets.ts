/** Demo control presets. Graded by the same inbound path as a Photon iMessage reply. */
export const DEMO_REPLY_PRESETS = [
  "new color looks nice",
  "cracked screen",
  "I need it for work tomorrow",
] as const;

export type DemoReplyPreset = (typeof DEMO_REPLY_PRESETS)[number];
