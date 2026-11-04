// 审批闸门：TikTok 写操作只能从这里进入。
// 飞书按钮只传动作 ID，操作者身份和状态都在服务端核对。
import type { Store } from './db.ts';
import type { ActionRow, ActionType } from './types.ts';

export type Executor = (action: ActionRow) => Promise<unknown>;

export type Claim =
  | { ok: true; run: () => Promise<{ ok: true; result: unknown } | { ok: false; error: string }> }
  | { ok: false; message: string };

export class ApprovalGate {
  private store: Store;
  private admins: Set<string>;
  private executors: Record<ActionType, Executor>;

  constructor(store: Store, admins: Iterable<string>, executors: Record<ActionType, Executor>) {
    this.store = store;
    this.admins = new Set(admins);
    this.executors = executors;
  }

  isAdmin(openId: string): boolean {
    return this.admins.has(openId);
  }

  propose(type: ActionType, shopId: string, payload: unknown, idempotencyKey: string): ActionRow {
    const action = this.store.insertAction(type, shopId, payload, idempotencyKey);
    this.store.audit('action.proposed', null, { id: action.id, type });
    return action;
  }

  /**
   * 同步完成身份和状态检查，所以飞书回调能在 3 秒内返回。
   * 真正的写接口放在返回的 run() 里，由队列异步执行。
   */
  approve(actionId: string, operator: string, patch?: object): Claim {
    if (!this.isAdmin(operator)) {
      this.store.audit('action.denied', operator, { id: actionId });
      return { ok: false, message: '你没有批准权限' };
    }
    const action = this.store.action(actionId);
    if (!action) return { ok: false, message: '找不到这个动作' };
    if (!this.store.claimAction(actionId, 'running', operator)) {
      return { ok: false, message: `这个动作已经处理过（${action.status}）` };
    }
    if (patch) this.store.mergeActionPayload(actionId, patch);
    this.store.audit('action.approved', operator, { id: actionId, type: action.type, patch });

    return {
      ok: true,
      run: async () => {
        try {
          const result = await this.executors[action.type](this.store.action(actionId)!);
          this.store.finishAction(actionId, 'done', result);
          this.store.audit('action.done', operator, { id: actionId });
          return { ok: true as const, result };
        } catch (err) {
          const error = (err as Error).message;
          // 结果不确定时不自动重试，避免重复发布。失败后由人决定下一步。
          this.store.finishAction(actionId, 'failed', { error });
          this.store.audit('action.failed', operator, { id: actionId, error });
          return { ok: false as const, error };
        }
      },
    };
  }

  reject(actionId: string, operator: string): { ok: boolean; message: string } {
    if (!this.isAdmin(operator)) return { ok: false, message: '你没有操作权限' };
    if (!this.store.claimAction(actionId, 'rejected', operator)) return { ok: false, message: '这个动作已经处理过' };
    this.store.audit('action.rejected', operator, { id: actionId });
    return { ok: true, message: '已放弃' };
  }
}
