export type StateId =
  | 'START' | 'INTENT' | 'ASK_SERVICE' | 'ASK_MASTER' | 'ASK_DATE' | 'ASK_TIME'
  | 'OFFER_SLOTS' | 'ASK_CONTACT' | 'ASK_NAME' | 'CONFIRM' | 'FIND_BOOKING' | 'FAQ' | 'HANDOFF'
  | 'RESUME' | 'DONE';

export type Slots = {
  service?: string;
  masterId?: number;
  date?: string;                              // 'YYYY-MM-DD'
  time?: string;                              // 'HH:mm'
  timeRange?: { from: string; to: string };
  phone?: string;                             // '+79161234567'
  name?: string;                              // имя клиента с большой буквы
};

/** Конкретное окно из списка «ближайшее время»: дата + время + мастер. */
export type NearestOption = {
  date: string;                               // 'YYYY-MM-DD'
  time: string;                               // 'HH:mm'
  masterId: number;
  masterName: string;
};

export type Turn = { role: 'user' | 'bot'; text: string; at: number };

export type Ctx = {
  sessionId: string;
  /** Telegram user id (from.id), если диалог пришёл из Telegram. */
  telegramId?: number;
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
  /** Клиент отказался называть имя — не переспрашиваем до конца записи. */
  nameSkipped?: boolean;
  /** Предыдущее состояние: «назад» возвращает к нему. */
  prevAsked?: StateId;
  /** Состояние, из которого клиент отвлёкся вопросом: туда мы его вернём. */
  resume?: StateId;
  /** Почему клиент передан администратору: попадает в задачу CRM. */
  handoffReason?: string;
  /** Запись, которую клиент переносит или отменяет. */
  bookingId?: number;
  /** Найденные записи клиента — если их несколько, нужно выбрать. */
  bookings?: BookingRef[];
  /** Клиент просит ближайшее время, но услуга ещё не названа. */
  wantsNearest?: boolean;
  /** Показанные варианты «ближайшее время» — выбор из них в OFFER_SLOTS. */
  nearest?: NearestOption[];
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
  /** Телефон из записи: при переносе не спрашиваем его заново. */
  clientPhone?: string;
};

export type BotEvent =
  | { type: 'user_text'; text: string }
  | { type: 'reset' }
  | { type: 'silence'; ms: number }
  | { type: 'barge_in'; text: string }
  | { type: 'non_text'; kind: 'voice' | 'photo' | 'sticker' };

export type Action =
  | { type: 'create_booking'; slots: Slots; telegramId?: number }
  | { type: 'cancel_booking'; id: number; telegramId?: number }
  | { type: 'reschedule_booking'; id: number; date: string; time: string; telegramId?: number }
  | { type: 'handoff'; reason: string; contact?: string }
  | { type: 'end' };

export type StepResult = {
  ctx: Ctx;
  say: string[];
  actions: Action[];
  /** Что удалось разобрать в реплике: пишется в dialog_log.nlu для метрик. */
  nlu?: unknown;
  /**
   * Можно ли добавить к готовому ответу короткую живую вводную фразу.
   * `false` — ответ уже написан моделью или требует серьёзного тона.
   */
  humanize?: boolean;
};

/** Telegram user id из session_id вида `tg:<id>`; для CLI/eval — undefined. */
export function telegramIdFromSession(sessionId: string): number | undefined {
  const m = /^tg:(-?\d+)$/.exec(sessionId);
  return m ? Number(m[1]) : undefined;
}

export const newCtx = (sessionId: string, now: Date): Ctx => ({
  sessionId,
  telegramId: telegramIdFromSession(sessionId),
  state: 'START',
  slots: {},
  retries: {},
  history: [],
  lastActivityAt: now.getTime(),
});
