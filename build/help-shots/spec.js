// Figure spec for annotate-help-shots.js.
// Each figure: { name, shot, crop:[x,y,w,h], items:[...] }
// ALL coordinates are ORIGINAL raw-image pixels (raws are 2079x1256).
// Crops fully contain their subject with even margins; labels sit in the
// margin/backdrop so they never cover content.
// item types:
//   {type:'box',  x,y,w,h, r?, sw?, color?}   {type:'arrow', x1,y1,x2,y2, sw?, color?}
//   {type:'dot',  x,y, rad?, color?}          {type:'label', x,y, text, w?, color?}

const FIGURES = [
  // ---- Dashboard --------------------------------------------------------
  {
    name: 'dashboard', shot: 'dashboard', crop: [16, 16, 2047, 616],
    items: [
      { type: 'box', x: 1812, y: 45, w: 214, h: 52 },
      { type: 'label', x: 1372, y: 120, text: 'Start a brand-new job here', w: 360 },
      { type: 'arrow', x1: 1600, y1: 128, x2: 1900, y2: 98 },
      { type: 'box', x: 54, y: 150, w: 490, h: 230, color: 'blue' },
      { type: 'label', x: 1080, y: 452, text: '6 example jobs ship with the app — open one to study how it is built', w: 560, color: 'blue' },
      { type: 'arrow', x1: 1076, y1: 486, x2: 548, y2: 320, color: 'blue' },
    ],
  },

  // ---- New-job modal ----------------------------------------------------
  {
    name: 'newjob', shot: 'newjob', crop: [590, 430, 900, 402],
    items: [
      { type: 'box', x: 704, y: 554, w: 668, h: 46, color: 'blue' },
      { type: 'box', x: 704, y: 631, w: 668, h: 46, color: 'blue' },
      { type: 'box', x: 1302, y: 749, w: 80, h: 42 },
      { type: 'label', x: 706, y: 693, text: 'Name it, give a start URL, then Create', w: 430 },
      { type: 'arrow', x1: 1130, y1: 720, x2: 1300, y2: 768 },
    ],
  },

  // ---- Whole-screen anatomy --------------------------------------------
  {
    name: 'anatomy', shot: 'workspace-list', crop: [0, 0, 2079, 1256],
    items: [
      { type: 'box', x: 12, y: 228, w: 448, h: 150 },
      { type: 'label', x: 20, y: 392, text: '1  Your steps — the program you build', w: 430 },
      { type: 'box', x: 474, y: 66, w: 1592, h: 780, color: 'blue' },
      { type: 'label', x: 500, y: 74, text: '2  A real browser — load any website', w: 470, color: 'blue' },
      { type: 'box', x: 1897, y: 8, w: 90, h: 44 },
      { type: 'arrow', x1: 1900, y1: 92, x2: 1940, y2: 54 },
      { type: 'label', x: 1690, y: 96, text: 'Run', w: 90 },
      { type: 'box', x: 476, y: 906, w: 1594, h: 150, color: 'blue' },
      { type: 'label', x: 900, y: 962, text: '3  Results table → Export CSV', w: 420, color: 'blue' },
      { type: 'box', x: 476, y: 1150, w: 1594, h: 100 },
      { type: 'label', x: 900, y: 1152, text: '4  Log — exactly what happened', w: 430 },
    ],
  },

  // ---- Add-step directory (widened so labels sit inside each wide row) ---
  {
    name: 'addstep', shot: 'addstep', crop: [598, 44, 874, 916],
    items: [
      { type: 'box', x: 636, y: 150, w: 730, h: 72 },
      { type: 'box', x: 636, y: 226, w: 730, h: 72, color: 'blue' },
      { type: 'label', x: 1116, y: 168, text: 'A table? One pick grabs it', w: 244 },
      { type: 'label', x: 1116, y: 244, text: 'A repeating list? Many rows', w: 244, color: 'blue' },
    ],
  },

  // ---- Grab-a-list step editor (margins hold the numbered callouts) ------
  {
    name: 'grab-list-editor', shot: 'step-editor', crop: [404, 118, 1282, 1012],
    items: [
      { type: 'box', x: 697, y: 238, w: 702, h: 58 },
      { type: 'label', x: 1436, y: 248, text: '1  Pick one repeating row', w: 232 },
      { type: 'arrow', x1: 1434, y1: 272, x2: 1402, y2: 268 },
      { type: 'box', x: 697, y: 582, w: 702, h: 168, color: 'blue' },
      { type: 'label', x: 1436, y: 604, text: '2  Add a column, Pick the value inside the row', w: 240, color: 'blue' },
      { type: 'arrow', x1: 1434, y1: 648, x2: 1402, y2: 654, color: 'blue' },
      { type: 'box', x: 697, y: 792, w: 702, h: 246 },
      { type: 'label', x: 1436, y: 900, text: 'Preview the exact rows before you run', w: 240 },
      { type: 'arrow', x1: 1434, y1: 918, x2: 1402, y2: 918 },
    ],
  },

  // ---- The picker on a live page ---------------------------------------
  {
    name: 'picker', shot: 'picker', crop: [472, 60, 1607, 800],
    items: [
      { type: 'box', x: 950, y: 190, w: 150, h: 430 },
      { type: 'arrow', x1: 1236, y1: 300, x2: 1084, y2: 340 },
      { type: 'label', x: 1250, y: 268, text: 'Hover highlights a whole item — click to capture it', w: 470 },
      { type: 'label', x: 872, y: 700, text: 'The selector is written for you', w: 360, color: 'blue' },
      { type: 'arrow', x1: 1046, y1: 690, x2: 1200, y2: 456, color: 'blue' },
    ],
  },

  // ---- Results table + log (label sits in the empty lower-right) --------
  {
    name: 'results', shot: 'results-list', crop: [464, 900, 1615, 356],
    items: [
      { type: 'box', x: 490, y: 956, w: 1584, h: 152, color: 'blue' },
      { type: 'label', x: 1420, y: 1150, text: 'Prices are real numbers, not text', w: 360, color: 'blue' },
      { type: 'arrow', x1: 1690, y1: 1148, x2: 1700, y2: 1040, color: 'blue' },
    ],
  },

  // ---- Column shaping (side margins hold the labels) --------------------
  {
    name: 'columns', shot: 'columns', crop: [430, 452, 1240, 360],
    items: [
      { type: 'box', x: 738, y: 548, w: 508, h: 44 },
      { type: 'label', x: 452, y: 546, text: 'Rename the CSV heading', w: 236 },
      { type: 'arrow', x1: 690, y1: 566, x2: 736, y2: 568 },
      { type: 'box', x: 1300, y: 548, w: 88, h: 150, color: 'blue' },
      { type: 'label', x: 1420, y: 600, text: 'Reorder', w: 180, color: 'blue' },
      { type: 'arrow', x1: 1418, y1: 620, x2: 1392, y2: 620, color: 'blue' },
    ],
  },

  // ---- Report table → numbers ------------------------------------------
  {
    name: 'results-table', shot: 'results-table', crop: [464, 900, 1615, 356],
    items: [
      { type: 'label', x: 1300, y: 1150, text: 'One pick read the whole table — money as numbers', w: 480, color: 'blue' },
    ],
  },

  // ---- Filter job steps -------------------------------------------------
  {
    name: 'steps-filter', shot: 'workspace-filter', crop: [6, 218, 456, 640],
    items: [],
  },

  // ---- Paginated job steps ---------------------------------------------
  {
    name: 'steps-paginated', shot: 'workspace-paginated', crop: [6, 218, 456, 640],
    items: [],
  },

  // ---- The Map (data flow) ---------------------------------------------
  {
    name: 'map', shot: 'map', crop: [0, 0, 2079, 600],
    items: [
      { type: 'label', x: 1250, y: 330, text: 'Green wire = a value (price) flows to the step that uses it', w: 520, color: 'blue' },
      { type: 'arrow', x1: 1245, y1: 344, x2: 1012, y2: 250, color: 'blue' },
      { type: 'label', x: 120, y: 360, text: 'Colour = data · action · control · task', w: 360 },
    ],
  },

  // ---- The Map (modules as nodes) --------------------------------------
  {
    name: 'map-top', shot: 'map-top', crop: [0, 0, 2079, 600],
    items: [
      { type: 'label', x: 1264, y: 150, text: 'Each module is one node — double-click to open its own graph', w: 520 },
      { type: 'arrow', x1: 1300, y1: 182, x2: 1200, y2: 192 },
    ],
  },

  // ---- Sign-in panel ----------------------------------------------------
  {
    name: 'signin', shot: 'signin', crop: [6, 88, 456, 762],
    items: [],
  },

  // ---- Record mode ------------------------------------------------------
  {
    name: 'record', shot: 'record', crop: [472, 0, 1607, 360],
    items: [],
  },

  // ---- Quotes (login + Try/Recover) results ----------------------------
  {
    name: 'results-quotes', shot: 'results-quotes', crop: [464, 900, 1615, 356],
    items: [
      { type: 'label', x: 1240, y: 1150, text: 'Logged in first, then scraped — guarded by Try / Recover', w: 540, color: 'blue' },
    ],
  },
];

module.exports = { FIGURES };
