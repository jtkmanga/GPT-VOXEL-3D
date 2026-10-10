// Existing wire vocabulary only; P1 adds no protocol validation or new messages.
export const WS_MESSAGE = {
  AUTH: 'auth',
  AUTH_ERROR: 'auth_error',
  AUTH_REFRESHED: 'auth_refreshed',
  BOX_ERROR: 'box_error',
  BOX_REWARD: 'box_reward',
  BOX_SPIN_READY: 'box_spin_ready',
  BOX_STATE: 'box_state',
  COIN_COLLECT_RESULT: 'coin_collect_result',
  COIN_COLLECTED: 'coin_collected',
  COIN_STATE: 'coin_state',
  COLLECT: 'collect',
  COLLECT_BOX: 'collect_box',
  GHOST_SNAPSHOT: 'ghost_snapshot',
  HANDOFF_CANCEL: 'handoff_cancel',
  HANDOFF_CANCELLED: 'handoff_cancelled',
  HANDOFF_ERROR: 'handoff_error',
  HANDOFF_RESUME: 'handoff_resume',
  HANDOFF_RESUME_ERROR: 'handoff_resume_error',
  HANDOFF_RESUMED: 'handoff_resumed',
  JOIN: 'join',
  LEADERBOARD: 'leaderboard',
  LEAVE: 'leave',
  MOVE: 'move',
  SCORE: 'score',
  SERVER_ERROR: 'server_error',
  SPIN_BOX: 'spin_box',
  WELCOME: 'welcome',
  ZONE_CHANGE: 'zone_change'
};

export const PROTOCOL_VERSION = {
  LEGACY_ROOM: 4,
  ZONE_ROOM: 6
};
