/**
 * Stable test ids for every interactive element, shared by unit tests and the
 * web end-to-end run. Per-item ids are built with the helpers below.
 */
export const testIds = {
  flow: 'dive-flow',
  loading: 'dive-loading',
  notFound: 'dive-not-found',
  loadError: 'dive-load-error',
  next: 'dive-next',
  back: 'dive-back',
  close: 'dive-close',
  done: 'dive-done',
  error: 'dive-error',
  notice: 'dive-notice',
  progress: 'dive-progress',

  caseCard: 'case-card',
  contentWarning: 'content-warning',
  contentWarningAck: 'content-warning-ack',
  transparencyLink: 'transparency-link',

  startingFacts: 'starting-facts',
  beforeScreen: 'before-screen',
  afterScreen: 'after-screen',
  stepScreen: 'step-screen',
  finalScreen: 'final-screen',
  shareScreen: 'share-screen',

  slider: 'slider',
  sliderValue: 'slider-value',
  pollCommit: 'poll-commit',
  lockedNote: 'locked-note',

  confidence: 'confidence-label',
  goDeeper: 'go-deeper',
  depth: 'depth-layers',

  reveal: 'reveal',
  mirror: 'mirror',
  crowdChart: 'crowd-chart',
  crowdSummary: 'crowd-summary',
  crowdEmpty: 'crowd-empty',
  seededNote: 'seeded-note',
  versionNote: 'version-note',

  flagLink: 'flag-link',
  flagSheet: 'flag-sheet',
  flagNote: 'flag-note',
  flagSubmit: 'flag-submit',
  flagCancel: 'flag-cancel',
  flagThanks: 'flag-thanks',

  finalReveal: 'final-reveal',
  finalChart: 'final-chart',
  topStepYou: 'top-step-you',
  topStepCrowd: 'top-step-crowd',
  openQuestions: 'open-questions',
  steelmen: 'steelmen',
  fairness: 'fairness',
  fairnessSubmit: 'fairness-submit',
  fairnessThanks: 'fairness-thanks',

  shareCard: 'share-card',
  shareButton: 'share-button',
  shareStatus: 'share-status',
  shareDownload: 'share-download',
  copyLink: 'copy-link',

  transparency: 'transparency-page',
  sources: 'sources',
  versionHistory: 'version-history',
} as const;

export const depthLayerId = (layerId: string) => `depth-layer-${layerId}`;
export const sourceLinkId = (sourceId: string) => `source-link-${sourceId}`;
export const flagReasonId = (reason: string) => `flag-reason-${reason}`;
export const fairnessSideId = (sideId: string) => `fairness-side-${sideId}`;
export const fairnessRatingId = (rating: string) => `fairness-rating-${rating}`;
export const steelmanId = (sideId: string) => `steelman-${sideId}`;
export const versionRowId = (version: number) => `version-${version}`;
