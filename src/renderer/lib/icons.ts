/**
 * 线性图标集合：统一 24×24 viewBox，1.5px 线宽，颜色继承 currentColor。
 */

export const ICON_PATHS: Record<string, string> = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>',
  upload: '<path d="M12 16V3m-4 4 4-4 4 4M4 14v6h16v-6"/>',
  download: '<path d="M12 3v13m-4-4 4 4 4-4M4 15v6h16v-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  minus: '<path d="M5 12h14"/>',
  square: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  blocks:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  folder: '<path d="M3 6h7l2 3h9v11H3z"/>',
  'folder-open': '<path d="M3 10V5h7l2 3h8v3M3 11h19l-3 9H3z"/>',
  'folder-plus': '<path d="M3 6h7l2 3h9v11H3z"/><path d="M12 12v6m-3-3h6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v1"/>',
  workflow:
    '<rect x="8" y="2" width="8" height="5" rx="1"/><rect x="2" y="17" width="7" height="5" rx="1"/><rect x="15" y="17" width="7" height="5" rx="1"/><path d="M12 7v5M5 17v-5h14v5"/>',
  mouse: '<rect x="6" y="2" width="12" height="20" rx="6"/><path d="M12 2v7"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="m9 3 1-1h4l1 3 3 1 3 1v5l-2 2-1 3-3 1-1 3h-4l-1-3-3-1-2-2v-5l3-1z"/>',
  file: '<path d="M5 3h9l5 5v13H5zM14 3v6h5"/>',
  'file-plus': '<path d="M5 3h9l5 5v13H5zM14 3v6h5"/><path d="M12 12v6m-3-3h6"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  harddrive: '<path d="m5 4-3 9v6h20v-6l-3-9zM2 13h20M16 16h3"/>',
  pen: '<path d="m15 3 6 6L9 21H3v-6zM12 6l6 6"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18"/>',
  columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>',
  link: '<path d="m10 7 3-3a5 5 0 0 1 7 7l-3 3m-3 3-3 3a5 5 0 0 1-7-7l3-3m1 6 8-8"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m3 17 6-6 5 5 3-3 4 4"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
  undo: '<path d="M3 4v7h7M3 11a9 9 0 1 1 2 8"/>',
  redo: '<path d="M21 4v7h-7M21 11a9 9 0 1 0-2 8"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM21 2v4m-2-2h4"/>',
  shield: '<path d="m12 2 8 3v7c0 5-8 10-8 10S4 17 4 12V5zM8 12l3 3 5-6"/>',
  'arrow-up': '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  'panel-right': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h1M3 12h1M3 18h1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  power: '<path d="M12 3v9"/><path d="M7 6.5a7 7 0 1 0 10 0"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',
  quote: '<path d="M4 5h6v8H4V5Zm0 8c0 4 2 5 5 5M14 5h6v8h-6V5Zm0 8c0 4 2 5 5 5"/>',
  tasks: '<rect x="3" y="4" width="5" height="5" rx="1"/><path d="m3 16 2 2 4-5m3-7h9m-9 11h9"/>',
  heading: '<path d="M5 4v16m14-16v16M5 12h14"/>',
  paragraph: '<path d="M5 4h14M5 9h14M5 14h9M5 19h9"/>',
  type: '<path d="M4 6V4h16v2M12 4v16m-4 0h8"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3m-8 0 1 14h8l1-14M10 11v6m4-6v6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5"/>',
  'external-link': '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
  warning: '<path d="M12 3 2 21h20z"/><path d="M12 9v6m0 3v1"/>',
  eye: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/><path d="M12 8v5l3 2"/>',
  loader: '<path d="M12 3a9 9 0 1 0 9 9"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  wand: '<path d="m4 20 9-9M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 9l.7 1.3L21 11l-1.3.7L19 13l-.7-1.3L17 11l1.3-.7z"/>',
  palette:
    '<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h4a4 4 0 0 0 0-8z"/><circle cx="8" cy="9" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="16" cy="9" r="1"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-3 3 3 3m-6 0 3 3"/>',
  server:
    '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  import: '<path d="M12 3v12m-4-4 4 4 4-4M4 21h16"/>',
  export: '<path d="M12 21V9m-4 4 4-4 4 4M4 3h16"/>',
  'text-cursor': '<path d="M9 4h6M12 4v16m-3 0h6"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5M3 17l9 5 9-5"/>',
  robot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M8 13h.01M16 13h.01M9 17h6"/>',
  'chevron-left': '<path d="m15 6-6 6 6 6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-up': '<path d="m6 15 6-6 6 6"/>',
  'arrow-right': '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  'maximize-2': '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  'align-left': '<path d="M4 6h16M4 12h10M4 18h13"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  /* 内容模板：气泡星光标表示提示词，文本框与图片上下组合表示文生图/图生文，
     清单勾与日历勾/柱状图分别对应纪要、日报与周报。 */
  prompt:
    '<path d="M4 4h16v11H9l-5 4V4Z"/><path d="m12 7 1 2.2 2.2 1-2.2 1L12 13.4 11 11.2 8.8 10.2l2.2-1z"/>',
  'text-to-image':
    '<path d="M4 5h11M4 9h7"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><circle cx="8" cy="16.5" r="1"/><path d="m4 19 4.5-4 3.5 3 2.5-2.5L20 19"/>',
  'image-to-text':
    '<rect x="3" y="3" width="18" height="10" rx="1.5"/><circle cx="8" cy="6.5" r="1"/><path d="m4 12 4-4 3 3 2.5-2.5L20 12"/><path d="M4 17h13M4 21h9"/>',
  minutes:
    '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17"/>',
  daily:
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="m9 15.5 2 2 4-4"/>',
  weekly:
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 19v-4m4 4V11m4 8v-6"/>'
}

/** 由图标路径表派生的可用图标名称清单。 */
export const ICON_NAMES = Object.keys(ICON_PATHS)
