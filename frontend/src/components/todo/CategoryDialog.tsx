import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Modal } from "../ui/Modal";
import { GCAL_COLORS, GCAL_COLOR_NAMES } from "../calendar/EventDialog";
import { isSubmitEnter } from "../../lib/keys";
import type { TodoCategory } from "../../lib/api";

/** 카테고리 색의 기본값. 백엔드(`todo_store._DEFAULT_COLOR`)와 같은 값이어야
 *  "안 고르면 연두"가 화면과 저장소에서 어긋나지 않는다. */
export const DEFAULT_CAT_COLOR = "2";

export interface CategoryDraft {
  name: string;
  color: string;
  parent_id: string;
}

interface Props {
  open: boolean;
  /** 고칠 카테고리. 없으면 '새로 만들기'. */
  edit?: TodoCategory | null;
  /** 새로 만들 때의 상위 카테고리(사이드바에서 고른 것). */
  defaultParent?: string;
  /** 상위 카테고리 고르개에 채울 목록 */
  cats: TodoCategory[];
  busy?: boolean;
  onClose: () => void;
  /** 저장. 실제로 저장됐으면 true — false 면 창을 열어 둔 채 고칠 수 있게 한다. */
  onSubmit: (draft: CategoryDraft) => Promise<boolean>;
}

/** 트리를 들여쓰기 순서로 편다. `skip` 과 그 자손은 뺀다(자기 밑으로 옮길 수 없다). */
function flatten(cats: TodoCategory[], skip = ""): { cat: TodoCategory; depth: number }[] {
  const kids = new Map<string, TodoCategory[]>();
  for (const c of cats) {
    const k = kids.get(c.parent_id) ?? [];
    k.push(c);
    kids.set(c.parent_id, k);
  }
  const byId = new Set(cats.map((c) => c.id));
  const out: { cat: TodoCategory; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string, depth: number) => {
    for (const c of kids.get(parent) ?? []) {
      if (seen.has(c.id) || c.id === skip) continue;
      seen.add(c.id);
      out.push({ cat: c, depth });
      walk(c.id, depth + 1);
    }
  };
  // 부모가 사라진 항목도 최상위로 올려 목록에서 잃지 않는다
  for (const r of cats.filter((c) => !c.parent_id || !byId.has(c.parent_id))) {
    if (seen.has(r.id) || r.id === skip) continue;
    seen.add(r.id);
    out.push({ cat: r, depth: 0 });
    walk(r.id, 1);
  }
  return out;
}

/**
 * 카테고리 만들기·고치기 창.
 *
 * 예전에는 `window.prompt` 로 이름만 물었다. 색은 아예 고를 수 없었고, 상위
 * 카테고리는 "만들 때 사이드바에서 고른 것"으로 고정이라 나중에 옮길 수 없었다.
 */
export function CategoryDialog({
  open, edit, defaultParent = "", cats, busy = false, onClose, onSubmit,
}: Props) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_CAT_COLOR);
  const [parent, setParent] = useState("");

  // 열 때마다 값을 다시 채운다. 창을 항상 그려 두고 open 으로만 여닫으므로
  // (Modal 이 닫혀 있으면 null 을 그린다) 이 자리에서 초기화해야 한다.
  useEffect(() => {
    if (!open) return;
    setName(edit?.name ?? "");
    setColor(edit?.color || DEFAULT_CAT_COLOR);
    setParent(edit ? edit.parent_id : defaultParent);
  }, [open, edit, defaultParent]);

  const canSubmit = !!name.trim() && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    const ok = await onSubmit({ name: name.trim(), color, parent_id: parent });
    if (ok) onClose();
  };

  const options = flatten(cats, edit?.id ?? "");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={edit ? "카테고리 편집" : "새 카테고리"}
      width="max-w-sm"
    >
      <div className="space-y-3">
        <label className="block">
          <span className="label">이름</span>
          <input
            className="input mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (isSubmitEnter(e)) void submit(); }}
            placeholder="예: 논문"
            maxLength={100}
          />
        </label>

        <div>
          <span className="label">색상</span>
          <p className="mt-0.5 text-[11px] text-fg-subtle">
            이 카테고리의 할 일은 색을 따로 고르지 않으면 이 색으로 보입니다.
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {Object.entries(GCAL_COLORS).map(([id, hex]) => (
              <button
                key={id}
                type="button"
                onClick={() => setColor(id)}
                aria-label={GCAL_COLOR_NAMES[id]}
                aria-pressed={color === id}
                title={GCAL_COLOR_NAMES[id]}
                // 캘린더·할 일 상세의 색 고르개와 같은 모양 — 점은 작게, 누를 자리는 넓게
                className={`h-7 w-7 rounded-full border-2 bg-clip-content p-[3px] ${
                  color === id ? "border-fg" : "border-transparent"
                }`}
                style={{ background: hex }}
              />
            ))}
          </div>
        </div>

        <label className="block">
          <span className="label">상위 카테고리</span>
          <select
            className="input mt-1"
            value={parent}
            onChange={(e) => setParent(e.target.value)}
          >
            <option value="">(최상위)</option>
            {options.map(({ cat, depth }) => (
              <option key={cat.id} value={cat.id}>
                {`${"  ".repeat(depth)}${cat.name}`}
              </option>
            ))}
          </select>
          {edit && (
            <span className="mt-1 block text-[11px] text-fg-subtle">
              자기 자신이나 하위 카테고리 아래로는 옮길 수 없습니다.
            </span>
          )}
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button type="button" className="btn btn-primary gap-2" onClick={submit} disabled={!canSubmit}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {edit ? "저장" : "만들기"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
