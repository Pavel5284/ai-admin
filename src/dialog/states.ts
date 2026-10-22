export type StateId =
  | 'START' | 'INTENT' | 'ASK_SERVICE' | 'ASK_MASTER' | 'ASK_DATE' | 'ASK_TIME'
  | 'OFFER_SLOTS' | 'ASK_CONTACT' | 'CONFIRM' | 'FIND_BOOKING' | 'FAQ' | 'HANDOFF'
  | 'RESUME' | 'DONE';

export type Slots = {
  service?: string;
  masterId?: number;
  date?: string;                              // 'YYYY-MM-DD'
  time?: string;                              // 'HH:mm'
  timeRange?: { from: string; to: string };
  phone?: string;                             // '+79161234567'
  phoneDraft?: string;                        // накопленные цифры, пока номер неполный
  name?: string;
};

export type Turn = { role: 'user' | 'bot'; text: string; at: number };

export type Ctx = {
  sessionId: string;
  state: StateId;
  slots: Slots;
  retries: Record<string, number>;
  history: Turn[];
  lastActivityAt: number;
  outcome?: 'booked' | 'handoff' | 'cancelled' | 'abandoned' | 'faq_answered' | 'faq_declined' | 'rescheduled';
  /** Что именно ждём от клиента в текущем состоянии: отмена записи или «что изменить». */
  pending?: 'cancel' | 'change' | 'reschedule';
  /** Состояние, вопрос которого был задан последним: нужно для глобального «назад». */
  lastAsked?: StateId;
  /** Предыдущее состояние: «назад» возвращает к нему. */
  prevAsked?: StateId;
  /** Состояние, из которого клиент отвлёкся вопросом: туда мы его вернём. */
  resume?: StateId;
  /** Запись, которую клиент переносит или отменяет. */
  bookingId?: number;
  /** Найденные записи клиента — если их несколько, нужно выбрать. */
  bookings?: BookingRef[];
};

/** Запись, найденная по телефону: то, что нужно для переноса и отмены. */
export type BookingRef = {
  id: number;
  masterId: number;
  masterName: string;
  serviceCode: string;
  serviceTitle: string;
  date: string;              // 'YYYY-MM-DD'
  time: string;              // 'HH:mm'
};

export type BotEvent =
  | { type: 'user_text'; text: string }
  | { type: 'silence'; ms: number }
  | { type: 'barge_in'; text: string }
  | { type: 'non_text'; kind: 'voice' | 'photo' | 'sticker' };

export type Action =
  | { type: 'create_booking'; slots: Slots }
  | { type: 'cancel_booking'; id: number }
  | { type: 'reschedule_booking'; id: number; date: string; time: string }
  | { type: 'handoff'; reason: string }
  | { type: 'end' };

export type StepResult = {
  ctx: Ctx;
  say: string[];
  actions: Action[];
  /** Что удалось разобрать в реплике: пишется в dialog_log.nlu для метрик. */
  nlu?: unknown;
};

export const newCtx = (sessionId: string, now: Date): Ctx => ({
  sessionId, state: 'START', slots: {}, retries: {}, history: [], lastActivityAt: now.getTime(),
});
