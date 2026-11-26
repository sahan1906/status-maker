export type TemplateCategory = 'travel' | 'birthday' | 'love' | 'vibes' | 'festivals';

export type PaceMode = 'fast' | 'normal' | 'slow';

export type LandscapeTilt = 'right' | 'left';

export type TransitionType =
  | 'none'
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
  { id: 'auto', label: 'Template Auto' },
  { id: 'none', label: 'None (Hard Cut)' },
  { id: 'hyper-zoom', label: 'Hyper Zoom' },
  { id: 'whip-pan', label: 'Whip Pan' },
  { id: 'spin-twist', label: 'Spin Twist' },
  { id: 'rgb-glitch', label: 'RGB Glitch' },
  { id: 'prism-burn', label: 'Prism Leak' },
  { id: 'split-open', label: 'Split Open' },
  { id: 'diagonal-slash', label: 'Diagonal Slash' },
  { id: 'shutter-flash', label: 'Shutter Flash' },
  { id: 'flip-3d', label: '3D Flip' },
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
  | 'film-grain-date'
  | 'cinema-sub'
  | 'swiss-tag'
  | 'flash-beat'
  | 'none'
  | 'magazine-masthead'
  | 'amber-leak-bokeh'
  | 'polaroid-caption'
  | 'neon-edge'
  | 'serif-luxe'
  | 'frosted-pill'
  | 'camcorder-rec'
  | 'kinetic-intro'
  | 'warm-embers'
  | 'gold-rule'
  | 'evening-bokeh'
  | 'heritage-card';

export interface ReelTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  tagline: string;
  badge: string;
  defaultTitle: string;
  defaultSubtitle: string;
  paceMultiplier: number;
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
  { id: 'travel', label: 'Trip & Travel' },
  { id: 'birthday', label: 'Birthday' },
  { id: 'love', label: 'Love & Anniversary' },
  { id: 'vibes', label: 'Daily Vibes' },
  { id: 'festivals', label: 'Festivals & Moments' },
];

export const PACE_SECONDS: Record<PaceMode, number> = {
  fast: 1.5,
  normal: 2.3,
  slow: 3.2,
};

export const BLANK_TEMPLATE: ReelTemplate = {
  id: 'blank-canvas',
  name: 'Blank Canvas',
  category: 'vibes',
  tagline: 'No text, no date stamp, no color filter — pure photos & video editing',
  badge: 'Blank',
  defaultTitle: '',
  defaultSubtitle: '',
  paceMultiplier: 1.0,
  transition: 'none',
  layout: 'full',
  grade: 'none',
  overlay: 'none',
  accentColor: '#FFFFFF',
  samplePhotos: [SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.vibesCafe],
};

export const REEL_TEMPLATES: ReelTemplate[] = [
  // 1. TRIP & TRAVEL (5)
  {
    id: '35mm-film-roll',
    name: '35mm Film Roll',
    category: 'travel',
    tagline: 'Warm Kodak tint, grain, prism burn & date stamp',
    badge: 'Prism Leak',
    defaultTitle: 'COASTAL HIGHWAY',
    defaultSubtitle: 'NOV 2026',
    paceMultiplier: 1.0,
    transition: 'prism-burn',
    layout: 'full',
    grade: 'kodak-warm',
    overlay: 'film-grain-date',
    accentColor: '#F97316',
    samplePhotos: [SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.sunriseGhat, SAMPLE_MEDIA.vibesCafe],
  },
  {
    id: 'cinema-letterbox',
    name: 'Cinema Letterbox',
    category: 'travel',
    tagline: '2.35:1 anamorphic bars & silky directional whip pan',
    badge: 'Whip Pan',
    defaultTitle: 'OUT OF OFFICE',
    defaultSubtitle: 'A SHORT FILM BY YOU',
    paceMultiplier: 1.05,
    transition: 'whip-pan',
    layout: 'letterbox',
    grade: 'teal-amber',
    overlay: 'cinema-sub',
    accentColor: '#38BDF8',
    samplePhotos: [SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.loveTwilight, SAMPLE_MEDIA.palaceArch],
  },
  {
    id: 'boarding-pass',
    name: 'Boarding Pass',
    category: 'travel',
    tagline: 'Floating 4:5 frame & high-speed vertical whip glide',
    badge: 'Whip Up',
    defaultTitle: 'GOA TO UDAIPUR',
    defaultSubtitle: 'GATE 04 · ARCHIVE',
    paceMultiplier: 0.95,
    transition: 'whip-up',
    layout: 'boarding-card',
    grade: 'clean-swiss',
    overlay: 'swiss-tag',
    accentColor: '#E4E4E7',
    samplePhotos: [SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.palaceArch, SAMPLE_MEDIA.sunriseGhat],
  },
  {
    id: 'fast-cut-edit',
    name: 'Fast Cut Edit',
    category: 'travel',
    tagline: 'High-energy hyper-zoom pull cuts & motion blur',
    badge: 'Hyper Zoom',
    defaultTitle: 'WEEKEND ESCAPE',
    defaultSubtitle: 'NON-STOP',
    paceMultiplier: 0.68,
    transition: 'hyper-zoom',
    layout: 'full',
    grade: 'punchy-pop',
    overlay: 'flash-beat',
    accentColor: '#FFFFFF',
    samplePhotos: [SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.vibesCafe, SAMPLE_MEDIA.sunriseGhat],
  },
  {
    id: 'gallery-drift',
    name: 'Gallery Drift',
    category: 'travel',
    tagline: 'Matte-white gallery cards with smooth 3D perspective flip',
    badge: '3D Flip',
    defaultTitle: 'Postcards',
    defaultSubtitle: 'Autumn Journal',
    paceMultiplier: 1.0,
    transition: 'flip-3d',
    layout: 'gallery-card',
    grade: 'soft-matte',
    overlay: 'none',
    accentColor: '#F4F4F5',
    samplePhotos: [SAMPLE_MEDIA.sunriseGhat, SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.palaceArch],
  },

  // 2. BIRTHDAY (5)
  {
    id: 'magazine-cover',
    name: 'Magazine Cover',
    category: 'birthday',
    tagline: 'Editorial masthead intro & sleek split-curtain reveal',
    badge: 'Split Open',
    defaultTitle: 'TWENTY FIVE',
    defaultSubtitle: 'THE BIRTHDAY ISSUE',
    paceMultiplier: 0.95,
    transition: 'split-open',
    layout: 'full',
    grade: 'editorial-contrast',
    overlay: 'magazine-masthead',
    accentColor: '#F5F5F4',
    samplePhotos: [SAMPLE_MEDIA.birthdaySparkler, SAMPLE_MEDIA.vibesCafe, SAMPLE_MEDIA.familyEvening],
  },
  {
    id: 'golden-hour',
    name: 'Golden Hour',
    category: 'birthday',
    tagline: 'Warm amber prism flare sweep & dreamy soft bokeh',
    badge: 'Prism Leak',
    defaultTitle: 'Happy Birthday',
    defaultSubtitle: 'Another trip around the sun',
    paceMultiplier: 1.0,
    transition: 'prism-burn',
    layout: 'full',
    grade: 'golden-leak',
    overlay: 'amber-leak-bokeh',
    accentColor: '#FBBF24',
    samplePhotos: [SAMPLE_MEDIA.birthdaySparkler, SAMPLE_MEDIA.birthdayCake, SAMPLE_MEDIA.sunriseGhat],
  },
  {
    id: 'instant-flash',
    name: 'Instant Flash',
    category: 'birthday',
    tagline: 'Minimalist Polaroid frame & camera strobe shutter flash',
    badge: 'Flash',
    defaultTitle: 'Make a wish',
    defaultSubtitle: '25.11.2026',
    paceMultiplier: 0.9,
    transition: 'shutter-flash',
    layout: 'polaroid',
    grade: 'instant-film',
    overlay: 'polaroid-caption',
    accentColor: '#FDE68A',
    samplePhotos: [SAMPLE_MEDIA.birthdaySparkler, SAMPLE_MEDIA.familyEvening, SAMPLE_MEDIA.birthdayCake],
  },
  {
    id: 'after-dark',
    name: 'After Dark',
    category: 'birthday',
    tagline: 'Moody dark vignette, neon hairline & vortex spin twist',
    badge: 'Spin Twist',
    defaultTitle: 'AFTER HOURS',
    defaultSubtitle: 'CELEBRATE TONIGHT',
    paceMultiplier: 0.8,
    transition: 'spin-twist',
    layout: 'full',
    grade: 'after-dark',
    overlay: 'neon-edge',
    accentColor: '#A78BFA',
    samplePhotos: [SAMPLE_MEDIA.birthdaySparkler, SAMPLE_MEDIA.festivalDiyas, SAMPLE_MEDIA.palaceArch],
  },
  {
    id: 'minimal-luxe',
    name: 'Minimal Luxe',
    category: 'birthday',
    tagline: 'Champagne-gold hairline, serif title & diagonal slash',
    badge: 'Slash',
    defaultTitle: 'Cheers to You',
    defaultSubtitle: 'A milestone worth celebrating',
    paceMultiplier: 1.05,
    transition: 'diagonal-slash',
    layout: 'champagne-hairline',
    grade: 'champagne-luxe',
    overlay: 'serif-luxe',
    accentColor: '#E7C88B',
    samplePhotos: [SAMPLE_MEDIA.birthdayCake, SAMPLE_MEDIA.birthdaySparkler, SAMPLE_MEDIA.palaceArch],
  },

  // 3. LOVE & ANNIVERSARY (5)
  {
    id: 'soft-cinema',
    name: 'Soft Cinema',
    category: 'love',
    tagline: 'Dreamy warm film haze & silky cinema dissolve',
    badge: 'Cinema Fade',
    defaultTitle: 'Always & Forever',
    defaultSubtitle: 'EST. 2021',
    paceMultiplier: 1.05,
    transition: 'dissolve',
    layout: 'full',
    grade: 'dream-haze',
    overlay: 'serif-luxe',
    accentColor: '#FDA4AF',
    samplePhotos: [SAMPLE_MEDIA.loveTwilight, SAMPLE_MEDIA.palaceArch, SAMPLE_MEDIA.sunriseGhat],
  },
  {
    id: 'dual-frame-story',
    name: 'Dual Frame Story',
    category: 'love',
    tagline: 'Split-screen 2-photo frames with split-open reveals',
    badge: 'Split Open',
    defaultTitle: 'Us, Lately',
    defaultSubtitle: 'OUR FAVORITE CHAPTERS',
    paceMultiplier: 1.0,
    transition: 'split-open',
    layout: 'dual-split',
    grade: 'kodak-warm',
    overlay: 'cinema-sub',
    accentColor: '#F5F5F4',
    samplePhotos: [SAMPLE_MEDIA.loveTwilight, SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.vibesCafe],
  },
  {
    id: 'film-burn',
    name: 'Film Burn',
    category: 'love',
    tagline: 'Organic amber & rose prism light-leak burns',
    badge: 'Prism Burn',
    defaultTitle: 'Golden Memories',
    defaultSubtitle: 'EVERY MOMENT COUNTS',
    paceMultiplier: 0.95,
    transition: 'prism-burn',
    layout: 'full',
    grade: 'golden-leak',
    overlay: 'film-grain-date',
    accentColor: '#FB923C',
    samplePhotos: [SAMPLE_MEDIA.loveTwilight, SAMPLE_MEDIA.sunriseGhat, SAMPLE_MEDIA.palaceArch],
  },
  {
    id: 'frosted-memory',
    name: 'Frosted Memory',
    category: 'love',
    tagline: 'Frosted-glass caption over smooth horizontal whip pans',
    badge: 'Whip Pan',
    defaultTitle: 'Happy Anniversary',
    defaultSubtitle: 'Still my favorite person',
    paceMultiplier: 1.05,
    transition: 'whip-pan',
    layout: 'full',
    grade: 'soft-matte',
    overlay: 'frosted-pill',
    accentColor: '#FFFFFF',
    samplePhotos: [SAMPLE_MEDIA.loveTwilight, SAMPLE_MEDIA.palaceArch, SAMPLE_MEDIA.familyEvening],
  },
  {
    id: 'mono-to-color',
    name: 'Mono to Color',
    category: 'love',
    tagline: 'Monochrome film blooming into color with silky dissolves',
    badge: 'B&W Bloom',
    defaultTitle: 'Timeless',
    defaultSubtitle: 'YOU & ME',
    paceMultiplier: 1.1,
    transition: 'dissolve',
    layout: 'full',
    grade: 'mono-bloom',
    overlay: 'serif-luxe',
    accentColor: '#E4E4E7',
    samplePhotos: [SAMPLE_MEDIA.loveTwilight, SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.palaceArch],
  },

  // 4. DAILY VIBES / PHOTO DUMP (5)
  {
    id: 'genz-photo-dump',
    name: 'Gen-Z Photo Dump',
    category: 'vibes',
    tagline: 'Snappy beat-paced hyper-zoom pulls & lowercase type',
    badge: 'Hyper Zoom',
    defaultTitle: 'november dump.',
    defaultSubtitle: 'little moments',
    paceMultiplier: 0.55,
    transition: 'hyper-zoom',
    layout: 'full',
    grade: 'punchy-pop',
    overlay: 'cinema-sub',
    accentColor: '#FFFFFF',
    samplePhotos: [SAMPLE_MEDIA.vibesCafe, SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.birthdaySparkler],
  },
  {
    id: 'retro-camcorder',
    name: 'Retro Camcorder',
    category: 'vibes',
    tagline: '90s/Y2K VHS scanlines, live REC timecode & RGB glitch',
    badge: 'RGB Glitch',
    defaultTitle: 'TAPE 04',
    defaultSubtitle: 'SP MODE',
    paceMultiplier: 0.9,
    transition: 'rgb-glitch',
    layout: 'full',
    grade: 'vhs-90s',
    overlay: 'camcorder-rec',
    accentColor: '#EF4444',
    samplePhotos: [SAMPLE_MEDIA.vibesCafe, SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.loveTwilight],
  },
  {
    id: 'glass-stage',
    name: 'Glass Stage',
    category: 'vibes',
    tagline: 'Blurred full-bleed backdrop behind a 3D flipping card',
    badge: '3D Flip',
    defaultTitle: 'Daily Frames',
    defaultSubtitle: 'CURATED MOMENTS',
    paceMultiplier: 0.95,
    transition: 'flip-3d',
    layout: 'glass-stage',
    grade: 'clean-swiss',
    overlay: 'frosted-pill',
    accentColor: '#E4E4E7',
    samplePhotos: [SAMPLE_MEDIA.vibesCafe, SAMPLE_MEDIA.sunriseGhat, SAMPLE_MEDIA.birthdaySparkler],
  },
  {
    id: 'kinetic-type',
    name: 'Kinetic Type',
    category: 'vibes',
    tagline: 'Bold oversized title intro slamming into spin-twist cuts',
    badge: 'Spin Twist',
    defaultTitle: 'LATELY',
    defaultSubtitle: 'LIFE IN FRAMES',
    paceMultiplier: 0.8,
    transition: 'spin-twist',
    layout: 'full',
    grade: 'editorial-contrast',
    overlay: 'kinetic-intro',
    accentColor: '#FFFFFF',
    samplePhotos: [SAMPLE_MEDIA.vibesCafe, SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.familyEvening],
  },
  {
    id: 'pure-minimal',
    name: 'Pure Minimal',
    category: 'vibes',
    tagline: 'Edge-to-edge ultra-clean motion & razor diagonal slash',
    badge: 'Diagonal',
    defaultTitle: 'Quiet Days',
    defaultSubtitle: '2026',
    paceMultiplier: 1.0,
    transition: 'diagonal-slash',
    layout: 'full',
    grade: 'soft-matte',
    overlay: 'cinema-sub',
    accentColor: '#D4D4D8',
    samplePhotos: [SAMPLE_MEDIA.vibesCafe, SAMPLE_MEDIA.sunriseGhat, SAMPLE_MEDIA.loveTwilight],
  },

  // 5. FESTIVALS & MOMENTS (5)
  {
    id: 'warm-glow',
    name: 'Warm Glow',
    category: 'festivals',
    tagline: 'Cinematic golden prism flare & soft floating warm embers',
    badge: 'Prism Leak',
    defaultTitle: 'Festival of Lights',
    defaultSubtitle: 'Warm wishes to you & yours',
    paceMultiplier: 1.0,
    transition: 'prism-burn',
    layout: 'full',
    grade: 'warm-heritage',
    overlay: 'warm-embers',
    accentColor: '#F59E0B',
    samplePhotos: [SAMPLE_MEDIA.festivalDiyas, SAMPLE_MEDIA.familyEvening, SAMPLE_MEDIA.palaceArch],
  },
  {
    id: 'editorial-festive',
    name: 'Editorial Festive',
    category: 'festivals',
    tagline: 'Celebratory title overlay, gold rule & whip-pan slides',
    badge: 'Whip Pan',
    defaultTitle: 'SHUBH UTSAV',
    defaultSubtitle: 'LIGHT · JOY · TOGETHERNESS',
    paceMultiplier: 0.95,
    transition: 'whip-pan',
    layout: 'full',
    grade: 'champagne-luxe',
    overlay: 'gold-rule',
    accentColor: '#FBBF24',
    samplePhotos: [SAMPLE_MEDIA.palaceArch, SAMPLE_MEDIA.festivalDiyas, SAMPLE_MEDIA.familyEvening],
  },
  {
    id: 'evening-bokeh',
    name: 'Evening Bokeh',
    category: 'festivals',
    tagline: 'Shallow depth-of-field warm lights & shutter flash cuts',
    badge: 'Flash',
    defaultTitle: 'Festive Evenings',
    defaultSubtitle: 'Lights & laughter',
    paceMultiplier: 1.0,
    transition: 'shutter-flash',
    layout: 'full',
    grade: 'after-dark',
    overlay: 'evening-bokeh',
    accentColor: '#FCD34D',
    samplePhotos: [SAMPLE_MEDIA.festivalDiyas, SAMPLE_MEDIA.birthdaySparkler, SAMPLE_MEDIA.palaceArch],
  },
  {
    id: 'heritage-film',
    name: 'Heritage Film',
    category: 'festivals',
    tagline: 'Warm cinema grade, minimal frame & split-curtain reveal',
    badge: 'Split Open',
    defaultTitle: 'Warmest Wishes',
    defaultSubtitle: 'From our home to yours',
    paceMultiplier: 1.05,
    transition: 'split-open',
    layout: 'heritage-frame',
    grade: 'warm-heritage',
    overlay: 'heritage-card',
    accentColor: '#E7C88B',
    samplePhotos: [SAMPLE_MEDIA.familyEvening, SAMPLE_MEDIA.palaceArch, SAMPLE_MEDIA.festivalDiyas],
  },
  {
    id: 'vibrant-cut',
    name: 'Vibrant Cut',
    category: 'festivals',
    tagline: 'Punchy vivid color boost with high-energy hyper-zoom',
    badge: 'Hyper Zoom',
    defaultTitle: 'CELEBRATE',
    defaultSubtitle: 'MEMORIES IN MOTION',
    paceMultiplier: 0.78,
    transition: 'hyper-zoom',
    layout: 'full',
    grade: 'vivid-boost',
    overlay: 'gold-rule',
    accentColor: '#FB923C',
    samplePhotos: [SAMPLE_MEDIA.familyEvening, SAMPLE_MEDIA.festivalDiyas, SAMPLE_MEDIA.sunriseGhat],
  },
];
