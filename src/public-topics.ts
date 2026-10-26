import { randomUUID } from "node:crypto";
import { createAuditRecord, type DocumentStore } from "./persistence.js";

export type PublicTopicStatus = "open" | "hidden" | "closed";
export type PublicMessageStatus = "visible" | "hidden";
export type ModerationReportStatus = "queued" | "dismissed" | "hidden" | "restored";
export type ModerationTargetType = "topic" | "message";

export interface PublicTopic {
  id: string;
  title: string;
  body: string;
  tags: string[];
  author_id: string;
  created_at: string;
  updated_at: string;
  status: PublicTopicStatus;
  room_id?: string;
  participant_count: number;
  message_count: number;
}

export interface PublicMessage {
  id: string;
  room_id: string;
  topic_id: string;
  author_id: string;
  body: string;
  created_at: string;
  status: PublicMessageStatus;
}

export interface PublicRoom {
  id: string;
  topic_id: string;
  created_at: string;
  status: "open" | "closed";
  participant_ids: string[];
  messages: PublicMessage[];
}

export interface ModerationReport {
  id: string;
  reporter_id: string;
  target_type: ModerationTargetType;
  target_id: string;
  reason: string;
  created_at: string;
  status: ModerationReportStatus;
  reviewer_id?: string;
  reviewed_at?: string;
}

export interface TopicDiscoveryInput {
  actorId?: string;
  query?: string;
  interests?: string[];
  limit?: number;
}

interface StoredTopic extends PublicTopic {
  room?: StoredRoom;
}

interface StoredRoom {
  id: string;
  topicId: string;
  createdAt: string;
  status: "open" | "closed";
  participantIds: Set<string>;
  messages: PublicMessage[];
}

interface PersistedTopicState {
  topics: Array<PublicTopic & { room?: { id: string; topic_id: string; created_at: string; status: "open" | "closed"; participant_ids: string[]; messages: PublicMessage[] } }>;
  reports: ModerationReport[];
  blocks: Record<string, string[]>;
}

export class PublicTopicService {
  private readonly topics = new Map<string, StoredTopic>();
  private readonly reports = new Map<string, ModerationReport>();
  private readonly blocks = new Map<string, Set<string>>();
  private store?: DocumentStore;

  constructor() {
    this.seed();
  }

  attachStore(store: DocumentStore): void {
    this.store = store;
  }

  async initialize(): Promise<void> {
    if (!this.store) return;
    const state = await this.store.load<PersistedTopicState>("public-topics-v1");
    if (!state) {
      this.persistSoon();
      return;
    }
    this.topics.clear();
    this.reports.clear();
    this.blocks.clear();
    for (const topic of state.topics ?? []) {
      const { room: persistedRoom, ...topicFields } = topic;
      const restored: StoredTopic = { ...topicFields };
      if (persistedRoom) {
        restored.room = {
          id: persistedRoom.id,
          topicId: persistedRoom.topic_id,
          createdAt: persistedRoom.created_at,
          status: persistedRoom.status,
          participantIds: new Set(persistedRoom.participant_ids),
          messages: persistedRoom.messages.map((message) => ({ ...message })),
        };
      }
      this.topics.set(restored.id, restored);
    }
    for (const report of state.reports ?? []) this.reports.set(report.id, { ...report });
    for (const [actorId, blockedIds] of Object.entries(state.blocks ?? {})) this.blocks.set(actorId, new Set(blockedIds));
  }

  discover(input: TopicDiscoveryInput = {}): PublicTopic[] {
    const actorId = normalizeActorId(input.actorId ?? "local-user");
    const query = (input.query ?? "").trim().toLocaleLowerCase();
    const interests = (input.interests ?? []).map((interest) => interest.toLocaleLowerCase());
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
    return [...this.topics.values()]
      .filter((topic) => topic.status === "open" && !this.cannotView(actorId, topic.author_id))
      .map((topic) => ({ topic, score: scoreTopic(topic, query, interests) }))
      .filter(({ topic, score }) => !query || score > 0)
      .sort((a, b) => b.score - a.score || b.topic.updated_at.localeCompare(a.topic.updated_at))
      .slice(0, limit)
      .map(({ topic }) => this.snapshotTopic(topic));
  }

  createTopic(input: { actorId: string; title: string; body: string; tags?: string[] }): PublicTopic {
    const actorId = normalizeActorId(input.actorId);
    const title = requireText(input.title, 3, 120, "标题");
    const body = requireText(input.body, 1, 2000, "内容");
    const tags = normalizeTags(input.tags ?? []);
    const now = new Date().toISOString();
    const topic: StoredTopic = {
      id: `topic-${randomUUID().slice(0, 8)}`,
      title,
      body,
      tags,
      author_id: actorId,
      created_at: now,
      updated_at: now,
      status: "open",
      participant_count: 0,
      message_count: 0,
    };
    this.topics.set(topic.id, topic);
    this.audit("topic.created", "topic", topic.id, actorId);
    this.persistSoon();
    return this.snapshotTopic(topic);
  }

  joinRoom(topicId: string, actorId: string): PublicRoom {
    const actor = normalizeActorId(actorId);
    const topic = this.requireTopic(topicId);
    if (topic.status !== "open") throw new Error("这个话题当前不可加入。");
    if (this.cannotView(actor, topic.author_id)) throw new Error("你无法加入这个话题。");
    if (!topic.room) {
      topic.room = {
        id: `room-${randomUUID().slice(0, 8)}`,
        topicId: topic.id,
        createdAt: new Date().toISOString(),
        status: "open",
        participantIds: new Set(),
        messages: [],
      };
      topic.room_id = topic.room.id;
    }
    topic.room.participantIds.add(actor);
    topic.participant_count = topic.room.participantIds.size;
    this.audit("room.joined", "room", topic.room.id, actor, { topic_id: topic.id });
    this.persistSoon();
    return this.snapshotRoom(topic, actor);
  }

  getRoom(roomId: string, actorId: string): PublicRoom {
    const actor = normalizeActorId(actorId);
    const topic = this.findTopicByRoom(roomId);
    if (!topic?.room) throw new Error("找不到这个讨论房间。");
    if (topic.status !== "open" || this.cannotView(actor, topic.author_id)) throw new Error("这个讨论房间当前不可访问。");
    topic.room.participantIds.add(actor);
    topic.participant_count = topic.room.participantIds.size;
    return this.snapshotRoom(topic, actor);
  }

  postMessage(roomId: string, actorId: string, body: string): PublicRoom {
    const actor = normalizeActorId(actorId);
    const topic = this.findTopicByRoom(roomId);
    if (!topic?.room) throw new Error("找不到这个讨论房间。");
    if (topic.status !== "open" || topic.room.status !== "open") throw new Error("这个讨论房间已经关闭。");
    if (this.cannotView(actor, topic.author_id)) throw new Error("你无法在这个讨论房间发言。");
    const message: PublicMessage = {
      id: `message-${randomUUID().slice(0, 8)}`,
      room_id: roomId,
      topic_id: topic.id,
      author_id: actor,
      body: requireText(body, 1, 2000, "发言内容"),
      created_at: new Date().toISOString(),
      status: "visible",
    };
    topic.room.participantIds.add(actor);
    topic.room.messages.push(message);
    topic.updated_at = message.created_at;
    topic.message_count = topic.room.messages.length;
    topic.participant_count = topic.room.participantIds.size;
    this.audit("message.created", "message", message.id, actor, { room_id: roomId, topic_id: topic.id });
    this.persistSoon();
    return this.snapshotRoom(topic, actor);
  }

  report(input: { reporterId: string; targetType: ModerationTargetType; targetId: string; reason: string }): ModerationReport {
    const reporterId = normalizeActorId(input.reporterId);
    const reason = requireText(input.reason, 3, 500, "举报理由");
    this.requireTarget(input.targetType, input.targetId);
    const report: ModerationReport = {
      id: `report-${randomUUID().slice(0, 8)}`,
      reporter_id: reporterId,
      target_type: input.targetType,
      target_id: input.targetId,
      reason,
      created_at: new Date().toISOString(),
      status: "queued",
    };
    this.reports.set(report.id, report);
    this.audit("moderation.reported", input.targetType, input.targetId, reporterId, { report_id: report.id });
    this.persistSoon();
    return { ...report };
  }

  listReports(status?: ModerationReportStatus): ModerationReport[] {
    return [...this.reports.values()]
      .filter((report) => !status || report.status === status)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((report) => ({ ...report }));
  }

  reviewReport(reportId: string, reviewerId: string, decision: "dismiss" | "hide" | "restore"): ModerationReport {
    const report = this.reports.get(reportId);
    if (!report) throw new Error("找不到这个举报记录。");
    const target = this.requireTarget(report.target_type, report.target_id);
    if (decision === "hide") setTargetStatus(target, "hidden");
    if (decision === "restore") setTargetStatus(target, "open");
    report.status = decision === "dismiss" ? "dismissed" : decision === "hide" ? "hidden" : "restored";
    report.reviewer_id = normalizeActorId(reviewerId);
    report.reviewed_at = new Date().toISOString();
    this.audit("moderation.reviewed", report.target_type, report.target_id, report.reviewer_id, { report_id: report.id, decision });
    this.persistSoon();
    return { ...report };
  }

  blockActor(actorId: string, blockedActorId: string): { actor_id: string; blocked_actor_id: string; blocked: boolean } {
    const actor = normalizeActorId(actorId);
    const blocked = normalizeActorId(blockedActorId);
    if (actor === blocked) throw new Error("不能拉黑自己。");
    const blockedActors = this.blocks.get(actor) ?? new Set<string>();
    blockedActors.add(blocked);
    this.blocks.set(actor, blockedActors);
    this.audit("actor.blocked", "actor", blocked, actor);
    this.persistSoon();
    return { actor_id: actor, blocked_actor_id: blocked, blocked: true };
  }

  unblockActor(actorId: string, blockedActorId: string): { actor_id: string; blocked_actor_id: string; blocked: boolean } {
    const actor = normalizeActorId(actorId);
    const blocked = normalizeActorId(blockedActorId);
    this.blocks.get(actor)?.delete(blocked);
    this.audit("actor.unblocked", "actor", blocked, actor);
    this.persistSoon();
    return { actor_id: actor, blocked_actor_id: blocked, blocked: false };
  }

  private seed(): void {
    const now = new Date().toISOString();
    const seeds: Array<[string, string, string[]]> = [
      ["AI 会怎样改变个人生活入口？", "从工具、陪伴和主动发现三个角度聊聊你希望 AI 成为什么。", ["ai", "product", "life"]],
      ["三分钟小游戏的最佳长度是多少？", "分享一个你愿意随时开始、也能随时结束的小游戏想法。", ["games", "design"]],
      ["如何开始一次低压力的公开聊天？", "不交换私人联系方式，只从一个具体话题开始认识彼此。", ["conversation", "community"]],
    ];
    for (const [index, [title, body, tags]] of seeds.entries()) {
      const topic: StoredTopic = {
        id: `topic-seed-${index + 1}`,
        title,
        body,
        tags,
        author_id: "community-seed",
        created_at: now,
        updated_at: now,
        status: "open",
        participant_count: 0,
        message_count: 0,
      };
      this.topics.set(topic.id, topic);
    }
  }

  private requireTopic(topicId: string): StoredTopic {
    const topic = this.topics.get(topicId);
    if (!topic) throw new Error("找不到这个公开话题。");
    return topic;
  }

  private findTopicByRoom(roomId: string): StoredTopic | undefined {
    return [...this.topics.values()].find((topic) => topic.room?.id === roomId);
  }

  private requireTarget(type: ModerationTargetType, id: string): StoredTopic | PublicMessage {
    if (type === "topic") return this.requireTopic(id);
    for (const topic of this.topics.values()) {
      const message = topic.room?.messages.find((item) => item.id === id);
      if (message) return message;
    }
    throw new Error("找不到要处理的公开内容。");
  }

  private cannotView(viewerId: string, authorId: string): boolean {
    return viewerId !== authorId && (this.blocks.get(viewerId)?.has(authorId) === true || this.blocks.get(authorId)?.has(viewerId) === true);
  }

  private snapshotTopic(topic: StoredTopic): PublicTopic {
    return {
      id: topic.id,
      title: topic.title,
      body: topic.body,
      tags: [...topic.tags],
      author_id: topic.author_id,
      created_at: topic.created_at,
      updated_at: topic.updated_at,
      status: topic.status,
      room_id: topic.room_id,
      participant_count: topic.participant_count,
      message_count: topic.message_count,
    };
  }

  private snapshotRoom(topic: StoredTopic, viewerId: string): PublicRoom {
    if (!topic.room) throw new Error("讨论房间尚未创建。");
    return {
      id: topic.room.id,
      topic_id: topic.id,
      created_at: topic.room.createdAt,
      status: topic.room.status,
      participant_ids: [...topic.room.participantIds],
      messages: topic.room.messages
        .filter((message) => message.status === "visible" && !this.cannotView(viewerId, message.author_id))
        .map((message) => ({ ...message })),
    };
  }

  private persistSoon(): void {
    if (!this.store) return;
    const topics = [...this.topics.values()].map((topic) => ({
      ...this.snapshotTopic(topic),
      room: topic.room
        ? {
            id: topic.room.id,
            topic_id: topic.id,
            created_at: topic.room.createdAt,
            status: topic.room.status,
            participant_ids: [...topic.room.participantIds],
            messages: topic.room.messages.map((message) => ({ ...message })),
          }
        : undefined,
    }));
    const blocks: Record<string, string[]> = {};
    for (const [actorId, blockedIds] of this.blocks) blocks[actorId] = [...blockedIds];
    void this.store.save("public-topics-v1", {
      topics,
      reports: [...this.reports.values()].map((report) => ({ ...report })),
      blocks,
    } satisfies PersistedTopicState);
  }

  private audit(action: string, resourceType: string, resourceId: string, actorId?: string, metadata: Record<string, unknown> = {}): void {
    if (this.store) void this.store.appendAudit(createAuditRecord(action, resourceType, resourceId, actorId, metadata));
  }
}

function scoreTopic(topic: StoredTopic, query: string, interests: string[]): number {
  const text = `${topic.title} ${topic.body} ${topic.tags.join(" ")}`.toLocaleLowerCase();
  if (!query && interests.length === 0) return 1;
  const queryHit = query && text.includes(query) ? 3 : 0;
  const interestHits = interests.filter((interest) => text.includes(interest)).length;
  return queryHit + interestHits;
}

function normalizeActorId(value: string): string {
  return requireText(value, 1, 120, "actor_id");
}

function requireText(value: string, minimum: number, maximum: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}必须是文本。`);
  const trimmed = value.trim();
  if (trimmed.length < minimum || trimmed.length > maximum) throw new Error(`${label}长度必须在 ${minimum}-${maximum} 之间。`);
  return trimmed;
}

function normalizeTags(tags: string[]): string[] {
  if (!Array.isArray(tags)) throw new Error("tags 必须是数组。");
  return [...new Set(tags.map((tag) => requireText(tag, 1, 40, "标签").toLocaleLowerCase()))].slice(0, 8);
}

function setTargetStatus(target: PublicTopic | PublicMessage, status: "open" | "hidden"): void {
  if ("title" in target) target.status = status;
  else target.status = status === "open" ? "visible" : "hidden";
}
