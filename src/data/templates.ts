export type TemplateCategory = 'all' | 'fx' | 'hype' | 'dump' | 'aesthetic';

export type SpecialEditMode =
  | 'none'
  | 'chroma-green-screen'
  | 'vn-shadow-reveal'
  | 'map-route-zoom'
  | 'india-train-map'
  | 'marvel-intro'
  | 'text-portal';

export type PaceMode = 'fast' | 'normal' | 'slow';

export type LandscapeTilt = 'right' | 'left';

export type MotionStyle =
  | 'none'
  | 'velocity-pump'
  | 'impact-shake'
  | 'drift-punch'
  | 'anime-impact'
  | 'strobe-flash'
  | 'bw-flash-drop'
  | 'blur-focus-pull'
  | 'handheld-sway'
  | 'vhs-jitter';

export type TransitionType =
  | 'none'
  | 'zoom-shake'
  | 'blur-whip'
  | 'flash-cut'
  | 'hyper-zoom'
  | 'whip-pan'
  | 'whip-up'
  | 'spin-twist'
  | 'rgb-glitch'
  | 'prism-burn'
  | 'split-open'
  | 'diagonal-slash'
  | 'shutter-flash'
  | 'flip-3d'
  | 'dissolve';

export type TransitionChoice = 'auto' | TransitionType;

export interface TransitionPreset {
  id: TransitionChoice;
  label: string;
}

export const TRANSITION_PRESETS: TransitionPreset[] = [
  { id: 'auto', label: 'Edit Auto' },
  { id: 'none', label: 'None (Hard Cut)' },
  { id: 'zoom-shake', label: 'Beat Zoom Shake' },
  { id: 'blur-whip', label: 'Blur Whip' },
  { id: 'flash-cut', label: 'Strobe Cut' },
  { id: 'hyper-zoom', label: 'Hyper Zoom' },
  { id: 'spin-twist', label: 'Spin Twist' },
  { id: 'rgb-glitch', label: 'RGB Glitch' },
  { id: 'prism-burn', label: 'Prism Leak' },
  { id: 'split-open', label: 'Split Open' },
  { id: 'diagonal-slash', label: 'Diagonal Slash' },
  { id: 'shutter-flash', label: 'Shutter Flash' },
  { id: 'flip-3d', label: '3D Flip' },
  { id: 'whip-pan', label: 'Whip Pan' },
  { id: 'whip-up', label: 'Whip Up' },
  { id: 'dissolve', label: 'Cinema Fade' },
];

export type FrameLayout =
  | 'full'
  | 'letterbox'
  | 'boarding-card'
  | 'gallery-card'
  | 'polaroid'
  | 'champagne-hairline'
  | 'dual-split'
  | 'glass-stage'
  | 'heritage-frame';

export type GradePreset =
  | 'none'
  | 'phonk-dark'
  | 'hdr-chrome'
  | 'euphoria-night'
  | 'flash-night'
  | 'cyber-glitch'
  | 'kodak-warm'
  | 'teal-amber'
  | 'clean-swiss'
  | 'punchy-pop'
  | 'soft-matte'
  | 'editorial-contrast'
  | 'golden-leak'
  | 'instant-film'
  | 'after-dark'
  | 'champagne-luxe'
  | 'dream-haze'
  | 'mono-bloom'
  | 'vhs-90s'
  | 'warm-heritage'
  | 'vivid-boost';

export type OverlayEffect =
  | 'none'
  | 'rgb-pulse'
  | 'speed-lines'
  | 'halation-glow'
  | 'vogue-bars'
  | 'camcorder-rec'
  | 'neon-edge'
  | 'film-grain-date'
  | 'cinema-sub'
  | 'swiss-tag'
  | 'flash-beat'
  | 'magazine-masthead'
  | 'amber-leak-bokeh'
  | 'polaroid-caption'
  | 'serif-luxe'
  | 'frosted-pill'
  | 'kinetic-intro'
  | 'warm-embers'
  | 'gold-rule'
  | 'evening-bokeh'
  | 'heritage-card';

export interface ReelTemplate {
  id: string;
  name: string;
  category: Exclude<TemplateCategory, 'all'>;
  tagline: string;
  badge: string;
  defaultTitle: string;
  defaultSubtitle: string;
  paceMultiplier: number;
  motionStyle: MotionStyle;
  specialMode?: SpecialEditMode;
  presetOverlayUrl?: string;
  chromaFitMode?: 'detected-rect' | 'full-frame';
  defaultChromaSensitivity?: number;
  isCustomOverlay?: boolean;
  transition: TransitionType;
  layout: FrameLayout;
  grade: GradePreset;
  overlay: OverlayEffect;
  accentColor: string;
  samplePhotos: string[];
}

export const SAMPLE_MEDIA = {
  travelCoast: '/src/assets/images/reel_travel_coast_1795609342228.jpg',
  sunriseGhat: '/src/assets/images/template_morning_sunrise_1795607970750.jpg',
  palaceArch: '/src/assets/images/template_wedding_royal_1795607975318.jpg',
  birthdaySparkler: '/src/assets/images/reel_birthday_sparkler_1795609344528.jpg',
  birthdayCake: '/src/assets/images/template_birthday_cake_1795607973010.jpg',
  loveTwilight: '/src/assets/images/reel_love_twilight_1795609346837.jpg',
  vibesCafe: '/src/assets/images/reel_vibes_cafe_1795609344815.jpg',
  festivalDiyas: '/src/assets/images/template_festival_diyas_1795607972836.jpg',
  familyEvening: '/src/assets/images/template_family_celebration_1795607972591.jpg',
} as const;

export const CATEGORIES: { id: TemplateCategory; label: string }[] = [
  { id: 'all', label: 'All Viral' },
  { id: 'fx', label: 'Chroma & Intros' },
  { id: 'hype', label: 'Velocity & Hype' },
  { id: 'dump', label: 'Photo Dump' },
  { id: 'aesthetic', label: 'Aesthetic & Y2K' },
];

export const PACE_SECONDS: Record<PaceMode, number> = {
  fast: 1.35,
  normal: 2.0,
  slow: 2.9,
};

export const BLANK_TEMPLATE: ReelTemplate = {
  id: 'blank-canvas',
  name: 'Blank Canvas',
  category: 'aesthetic',
  tagline: 'No effects, no text, no filters — pure photos & trimmed video',
  badge: 'Clean',
  defaultTitle: '',
  defaultSubtitle: '',
  paceMultiplier: 1.0,
  motionStyle: 'none',
  specialMode: 'none',
  transition: 'none',
  layout: 'full',
  grade: 'none',
  overlay: 'none',
  accentColor: '#FFFFFF',
  samplePhotos: [SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.vibesCafe],
};

export const REEL_TEMPLATES: ReelTemplate[] = [
  // 0. VIRAL CHROMA KEY, VN SHADOW REVEAL, TRAVEL MAP & TEXT PORTAL INTROS (5)
  {
    id: 'vn-shadow-reveal',
    name: 'VN Shadow Reveal',
    category: 'fx',
    tagline: 'Viral VN diagonal mirror-mask light beam sweeping across portraits out of pitch black',
    badge: 'Mirror Mask',
    defaultTitle: '',
    defaultSubtitle: '',
    paceMultiplier: 1.55,
    motionStyle: 'none',
    specialMode: 'vn-shadow-reveal',
    transition: 'dissolve',
    layout: 'full',
    grade: 'phonk-dark',
    overlay: 'none',
    accentColor: '#E4E4E7',
    samplePhotos: [SAMPLE_MEDIA.birthdaySparkler, SAMPLE_MEDIA.loveTwilight, SAMPLE_MEDIA.palaceArch],
  },
  {
    id: 'map-route-zoom',
    name: 'Map Route Zoom',
    category: 'fx',
    tagline: 'Animated glowing flight path across a 3D dark map zooming straight into your trip',
    badge: 'Travel Map',
    defaultTitle: 'MUMBAI',
    defaultSubtitle: 'GOA',
    paceMultiplier: 0.72,
    motionStyle: 'handheld-sway',
    specialMode: 'map-route-zoom',
    transition: 'blur-whip',
    layout: 'full',
    grade: 'teal-amber',
    overlay: 'none',
    accentColor: '#38BDF8',
    samplePhotos: [SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.sunriseGhat, SAMPLE_MEDIA.vibesCafe],
  },
  {
    id: 'india-train-map',
    name: 'India Train Map',
    category: 'fx',
    tagline: 'Animated express train gliding across India between any two cities into your trip',
    badge: 'India Train',
    defaultTitle: 'DELHI',
    defaultSubtitle: 'GOA',
    paceMultiplier: 0.72,
    motionStyle: 'handheld-sway',
    specialMode: 'india-train-map',
    transition: 'blur-whip',
    layout: 'full',
    grade: 'teal-amber',
    overlay: 'none',
    accentColor: '#F97316',
    samplePhotos: [SAMPLE_MEDIA.sunriseGhat, SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.palaceArch],
  },
  {
    id: 'green-screen-reveal',
    name: 'Green Screen Key',
    category: 'fx',
    tagline: 'Upload any green-screen video + photos/videos to play live inside the green area',
    badge: 'Chroma Key',
    defaultTitle: '',
    defaultSubtitle: '',
    paceMultiplier: 0.52,
    motionStyle: 'none',
    specialMode: 'chroma-green-screen',
    transition: 'whip-pan',
    layout: 'full',
    grade: 'none',
    overlay: 'none',
    accentColor: '#22C55E',
    samplePhotos: [SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.birthdaySparkler, SAMPLE_MEDIA.vibesCafe],
  },
  {
    id: 'marvel-flip-intro',
    name: 'Marvel Comic Intro',
    category: 'fx',
    tagline: 'Rapid 3D comic-panel flip inside condensed giant letters, zooming into your edit',
    badge: 'Comic Intro',
    defaultTitle: 'YOUR NAME',
    defaultSubtitle: '',
    paceMultiplier: 0.65,
    motionStyle: 'velocity-pump',
    specialMode: 'marvel-intro',
    transition: 'zoom-shake',
    layout: 'full',
    grade: 'punchy-pop',
    overlay: 'none',
    accentColor: '#EF4444',
    samplePhotos: [SAMPLE_MEDIA.birthdaySparkler, SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.palaceArch],
  },
  {
    id: 'text-portal-zoom',
    name: 'Name Portal Zoom',
    category: 'fx',
    tagline: 'Giant transparent cutout name reveals live video/photos & zooms straight through',
    badge: 'Text Mask',
    defaultTitle: 'AURA',
    defaultSubtitle: '',
    paceMultiplier: 0.72,
    motionStyle: 'impact-shake',
    specialMode: 'text-portal',
    transition: 'blur-whip',
    layout: 'full',
    grade: 'hdr-chrome',
    overlay: 'none',
    accentColor: '#38BDF8',
    samplePhotos: [SAMPLE_MEDIA.loveTwilight, SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.vibesCafe],
  },

  // 1. VELOCITY & HYPE (4)
  {
    id: 'velocity-beat',
    name: 'Velocity Beat',
    category: 'hype',
    tagline: 'Bass-pump zoom hits, beat shake & hyper-snap cuts',
    badge: 'Velocity',
    defaultTitle: '',
    defaultSubtitle: '',
    paceMultiplier: 0.62,
    motionStyle: 'velocity-pump',
    transition: 'zoom-shake',
    layout: 'full',
    grade: 'punchy-pop',
    overlay: 'rgb-pulse',
    accentColor: '#F43F5E',
    samplePhotos: [SAMPLE_MEDIA.birthdaySparkler, SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.vibesCafe],
  },
  {
    id: 'phonk-aura',
    name: 'Phonk Aura',
    category: 'hype',
    tagline: 'Dark crushed HDR, hard camera shake & RGB shockwave',
    badge: 'Aura',
    defaultTitle: '',
    defaultSubtitle: '',
    paceMultiplier: 0.66,
    motionStyle: 'impact-shake',
    transition: 'rgb-glitch',
    layout: 'full',
    grade: 'phonk-dark',
    overlay: 'rgb-pulse',
    accentColor: '#A855F7',
    samplePhotos: [SAMPLE_MEDIA.palaceArch, SAMPLE_MEDIA.birthdaySparkler, SAMPLE_MEDIA.loveTwilight],
  },
  {
    id: 'drift-hdr',
    name: 'Drift / Gym HDR',
    category: 'hype',
    tagline: 'Chrome HDR contrast, punch-in zoom & blur whip snaps',
    badge: 'HDR Punch',
    defaultTitle: '',
    defaultSubtitle: '',
    paceMultiplier: 0.64,
    motionStyle: 'drift-punch',
    transition: 'blur-whip',
    layout: 'full',
    grade: 'hdr-chrome',
    overlay: 'speed-lines',
    accentColor: '#38BDF8',
    samplePhotos: [SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.palaceArch, SAMPLE_MEDIA.birthdaySparkler],
  },
  {
    id: 'anime-impact',
    name: 'Impact Slash',
    category: 'hype',
    tagline: 'Speed-line impact frames, razor slash & vivid pop',
    badge: 'Impact',
    defaultTitle: '',
    defaultSubtitle: '',
    paceMultiplier: 0.58,
    motionStyle: 'anime-impact',
    transition: 'diagonal-slash',
    layout: 'full',
    grade: 'vivid-boost',
    overlay: 'speed-lines',
    accentColor: '#FACC15',
    samplePhotos: [SAMPLE_MEDIA.festivalDiyas, SAMPLE_MEDIA.birthdaySparkler, SAMPLE_MEDIA.sunriseGhat],
  },

  // 2. PHOTO DUMP (4)
  {
    id: 'flash-dump-05x',
    name: '0.5x Flash Dump',
    category: 'dump',
    tagline: 'Rapid camera-roll dump cuts with crisp strobe hits',
    badge: 'Fast Dump',
    defaultTitle: '',
    defaultSubtitle: '',
    paceMultiplier: 0.45,
    motionStyle: 'strobe-flash',
    transition: 'flash-cut',
    layout: 'full',
    grade: 'punchy-pop',
    overlay: 'none',
    accentColor: '#FFFFFF',
    samplePhotos: [SAMPLE_MEDIA.vibesCafe, SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.birthdaySparkler],
  },
  {
    id: 'bw-beat-drop',
    name: 'B&W Beat Drop',
    category: 'dump',
    tagline: 'High-contrast mono that flashes into full color on beat',
    badge: 'Color Drop',
    defaultTitle: '',
    defaultSubtitle: '',
    paceMultiplier: 0.82,
    motionStyle: 'bw-flash-drop',
    transition: 'split-open',
    layout: 'full',
    grade: 'editorial-contrast',
    overlay: 'vogue-bars',
    accentColor: '#E4E4E7',
    samplePhotos: [SAMPLE_MEDIA.loveTwilight, SAMPLE_MEDIA.vibesCafe, SAMPLE_MEDIA.palaceArch],
  },
  {
    id: 'night-flash',
    name: 'Night Flash',
    category: 'dump',
    tagline: 'Direct digicam flash pop & crisp night-out shutter cuts',
    badge: 'Digicam',
    defaultTitle: '',
    defaultSubtitle: '',
    paceMultiplier: 0.56,
    motionStyle: 'strobe-flash',
    transition: 'shutter-flash',
    layout: 'full',
    grade: 'flash-night',
    overlay: 'none',
    accentColor: '#FDE68A',
    samplePhotos: [SAMPLE_MEDIA.birthdaySparkler, SAMPLE_MEDIA.vibesCafe, SAMPLE_MEDIA.familyEvening],
  },
  {
    id: 'glitch-core',
    name: 'Glitch Core',
    category: 'dump',
    tagline: 'RGB slice tearing, cyberpunk neon edge & beat jitter',
    badge: 'Cyber RGB',
    defaultTitle: '',
    defaultSubtitle: '',
    paceMultiplier: 0.54,
    motionStyle: 'impact-shake',
    transition: 'rgb-glitch',
    layout: 'full',
    grade: 'cyber-glitch',
    overlay: 'neon-edge',
    accentColor: '#22D3EE',
    samplePhotos: [SAMPLE_MEDIA.birthdaySparkler, SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.festivalDiyas],
  },

  // 3. AESTHETIC & Y2K (4)
  {
    id: 'blur-focus-pull',
    name: 'Blur Focus Pull',
    category: 'aesthetic',
    tagline: 'Viral dreamy lens blur snapping into crystal-sharp focus',
    badge: 'Lens Blur',
    defaultTitle: '',
    defaultSubtitle: '',
    paceMultiplier: 0.88,
    motionStyle: 'blur-focus-pull',
    transition: 'prism-burn',
    layout: 'full',
    grade: 'dream-haze',
    overlay: 'halation-glow',
    accentColor: '#FDA4AF',
    samplePhotos: [SAMPLE_MEDIA.loveTwilight, SAMPLE_MEDIA.sunriseGhat, SAMPLE_MEDIA.vibesCafe],
  },
  {
    id: 'main-character',
    name: 'Main Character',
    category: 'aesthetic',
    tagline: 'A24 moody teal-rose halation glow & silky 3D camera sway',
    badge: 'A24 Glow',
    defaultTitle: '',
    defaultSubtitle: '',
    paceMultiplier: 0.92,
    motionStyle: 'handheld-sway',
    transition: 'dissolve',
    layout: 'full',
    grade: 'euphoria-night',
    overlay: 'halation-glow',
    accentColor: '#F472B6',
    samplePhotos: [SAMPLE_MEDIA.loveTwilight, SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.sunriseGhat],
  },
  {
    id: '3d-camera-roll',
    name: '3D Camera Roll',
    category: 'aesthetic',
    tagline: 'Floating glass frame, 3D handheld sway & spin-twist cuts',
    badge: '3D Motion',
    defaultTitle: '',
    defaultSubtitle: '',
    paceMultiplier: 0.76,
    motionStyle: 'handheld-sway',
    transition: 'spin-twist',
    layout: 'glass-stage',
    grade: 'clean-swiss',
    overlay: 'none',
    accentColor: '#E4E4E7',
    samplePhotos: [SAMPLE_MEDIA.vibesCafe, SAMPLE_MEDIA.sunriseGhat, SAMPLE_MEDIA.travelCoast],
  },
  {
    id: 'y2k-camcorder',
    name: 'Y2K Camcorder',
    category: 'aesthetic',
    tagline: '2000s Sony Handycam scanlines, tape jitter & live REC',
    badge: 'Y2K VHS',
    defaultTitle: '',
    defaultSubtitle: '',
    paceMultiplier: 0.78,
    motionStyle: 'vhs-jitter',
    transition: 'rgb-glitch',
    layout: 'full',
    grade: 'vhs-90s',
    overlay: 'camcorder-rec',
    accentColor: '#EF4444',
    samplePhotos: [SAMPLE_MEDIA.vibesCafe, SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.birthdaySparkler],
  },
];
