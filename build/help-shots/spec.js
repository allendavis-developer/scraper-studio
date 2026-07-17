// Figure spec for annotate-help-shots.js.
// Each figure: { name, shot, crop:[x,y,w,h], items:[...] }
// ALL coordinates are ORIGINAL raw-image pixels (raws are 2079x1256).
// item types:
//   {type:'box',  x,y,w,h, r?, sw?, color?}          rounded outline
//   {type:'arrow', x1,y1,x2,y2, sw?, color?}          line w/ arrowhead at (x2,y2)
//   {type:'dot',  x,y, rad?, color?}                  filled dot
//   {type:'label', x,y, text, w?, color?}             text chip (color: default red | 'blue')

const FIGURES = [
  // ---- Dashboard --------------------------------------------------------
  {
    name: 'dashboard', shot: 'dashboard', crop: [18, 18, 2043, 624],
    items: [
      { type: 'box', x: 1812, y: 45, w: 214, h: 52 },
      { type: 'label', x: 1360, y: 118, text: 'Start a brand-new job here', w: 380 },
      { type: 'arrow', x1: 1600, y1: 128, x2: 1900, y2: 96 },
      { type: 'box', x: 52, y: 150, w: 492, h: 232, color: 'blue' },
      { type: 'label', x: 560, y: 250, text: '6 example jobs ship with the app — open one to study how it is built', w: 560, color: 'blue' },
    ],
  },

  // ---- New-job modal ----------------------------------------------------
  {
    name: 'newjob', shot: 'newjob', crop: [636, 430, 800, 400],
    items: [
      { type: 'box', x: 706, y: 556, w: 664, h: 44, color: 'blue' },
      { type: 'box', x: 706, y: 632, w: 664, h: 44, color: 'blue' },
      { type: 'box', x: 1306, y: 752, w: 74, h: 40 },
      { type: 'label', x: 806, y: 790, text: 'Name it, give the start URL, Create', w: 420 },
      { type: 'arrow', x1: 1180, y1: 800, x2: 1330, y2: 780 },
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
      { type: 'label', x: 900, y: 1150, text: '4  Log — exactly what happened', w: 430 },
    ],
  },

  // ---- Add-step directory ----------------------------------------------
  {
    name: 'addstep', shot: 'addstep', crop: [600, 48, 840, 900],
    items: [
      { type: 'box', x: 630, y: 148, w: 728, h: 68 },
      { type: 'box', x: 630, y: 222, w: 728, h: 68 },
      { type: 'label', x: 1130, y: 150, text: 'A table? One pick grabs it all', w: 320 },
      { type: 'label', x: 1130, y: 246, text: 'A repeating list? Many rows at once', w: 340, color: 'blue' },
    ],
  },

  // ---- Grab-a-list step editor -----------------------------------------
  {
    name: 'grab-list-editor', shot: 'step-editor', crop: [648, 140, 720, 940],
    items: [
      { type: 'box', x: 676, y: 236, w: 700, h: 92 },
      { type: 'label', x: 690, y: 150, text: '1  Pick one repeating row', w: 330 },
      { type: 'box', x: 676, y: 566, w: 700, h: 150, color: 'blue' },
      { type: 'label', x: 690, y: 500, text: '2  Add a column, Pick the value inside the row', w: 470, color: 'blue' },
      { type: 'box', x: 676, y: 766, w: 700, h: 220 },
      { type: 'label', x: 700, y: 1000, text: 'Preview the exact rows before you run', w: 430 },
    ],
  },

  // ---- The picker on a live page ---------------------------------------
  {
    name: 'picker', shot: 'picker', crop: [472, 60, 1607, 800],
    items: [
      { type: 'box', x: 950, y: 190, w: 150, h: 430 },
      { type: 'arrow', x1: 1230, y1: 300, x2: 1080, y2: 340 },
      { type: 'label', x: 1245, y: 270, text: 'Hover highlights a whole item — click to capture it', w: 470 },
      { type: 'label', x: 880, y: 700, text: 'The selector is written for you', w: 380, color: 'blue' },
      { type: 'arrow', x1: 1050, y1: 690, x2: 1200, y2: 455, color: 'blue' },
    ],
  },

  // ---- Results table + log ---------------------------------------------
  {
    name: 'results', shot: 'results-list', crop: [468, 900, 1611, 356],
    items: [
      { type: 'box', x: 480, y: 958, w: 1590, h: 150, color: 'blue' },
      { type: 'label', x: 520, y: 964, text: 'One clean row per item — price is a real number', w: 520, color: 'blue' },
      { type: 'box', x: 480, y: 1180, w: 1590, h: 72 },
      { type: 'label', x: 900, y: 1120, text: 'The log narrates the run', w: 340 },
    ],
  },

  // ---- Column shaping ---------------------------------------------------
  {
    name: 'columns', shot: 'columns', crop: [648, 452, 720, 320],
    items: [
      { type: 'box', x: 700, y: 528, w: 500, h: 40 },
      { type: 'label', x: 700, y: 470, text: 'Rename, drop, reorder — then Apply', w: 430 },
      { type: 'box', x: 1250, y: 528, w: 90, h: 150 },
      { type: 'label', x: 1210, y: 690, text: 'Reorder', w: 160, color: 'blue' },
    ],
  },

  // ---- Report table → numbers ------------------------------------------
  {
    name: 'results-table', shot: 'results-table', crop: [468, 900, 1611, 356],
    items: [
      { type: 'label', x: 520, y: 916, text: 'One pick read the whole table — money comes out as numbers', w: 640, color: 'blue' },
    ],
  },

  // ---- Filter job steps -------------------------------------------------
  {
    name: 'steps-filter', shot: 'workspace-filter', crop: [8, 220, 452, 640],
    items: [
      { type: 'label', x: 24, y: 232, text: 'For each row: grab a value, If it fails the rule → Skip', w: 400 },
    ],
  },

  // ---- Paginated job steps ---------------------------------------------
  {
    name: 'steps-paginated', shot: 'workspace-paginated', crop: [8, 220, 452, 640],
    items: [
      { type: 'label', x: 24, y: 232, text: 'While there is a next page: scrape, click next, repeat', w: 400 },
    ],
  },

  // ---- The Map (data flow) ---------------------------------------------
  {
    name: 'map', shot: 'map', crop: [0, 0, 2079, 640],
    items: [
      { type: 'label', x: 1020, y: 250, text: 'Green wire = a value (price) flows into the step that uses it', w: 560, color: 'blue' },
      { type: 'arrow', x1: 1180, y1: 268, x2: 1030, y2: 245, color: 'blue' },
      { type: 'label', x: 240, y: 120, text: 'Colour = data / action / control / task', w: 380 },
    ],
  },

  // ---- The Map (modules as nodes) --------------------------------------
  {
    name: 'map-top', shot: 'map-top', crop: [0, 0, 2079, 640],
    items: [
      { type: 'label', x: 1180, y: 130, text: 'Each module is one node — double-click to open its own graph', w: 560 },
      { type: 'arrow', x1: 1300, y1: 160, x2: 1120, y2: 185 },
    ],
  },

  // ---- Sign-in panel ----------------------------------------------------
  {
    name: 'signin', shot: 'signin', crop: [8, 90, 452, 760],
    items: [
      { type: 'label', x: 24, y: 100, text: 'Sign in once — it is remembered (2FA included)', w: 400 },
    ],
  },

  // ---- Record mode ------------------------------------------------------
  {
    name: 'record', shot: 'record', crop: [472, 0, 1607, 360],
    items: [
      { type: 'label', x: 900, y: 250, text: 'Press Record, act on the page — it becomes steps', w: 470 },
    ],
  },

  // ---- Quotes (login + Try/Recover) results ----------------------------
  {
    name: 'results-quotes', shot: 'results-quotes', crop: [468, 900, 1611, 356],
    items: [
      { type: 'label', x: 520, y: 916, text: 'Logged in first, then scraped — guarded by Try / Recover', w: 600, color: 'blue' },
    ],
  },
];

module.exports = { FIGURES };
