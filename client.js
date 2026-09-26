/** Client half: a "记忆" page inside the settings panel (settings.section slot). */

const API_BASE = '/dsh-destinywind-memory';

window.__ModuleLoader__.load({
  id: 'dsh-destinywind-memory',
  factory(require) {
    const React = require('react');

    const SLOT_NAME = 'settings.section';
    const ENTRY_ID = 'destinywind-memory';
    // 16 = 紧跟内置的「插件」页(order 15), 排在「技能」页(17)之上。
    const SLOT_ORDER = 16;

    async function apiList() {
      const res = await fetch(`${API_BASE}/memories`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`读取失败 (HTTP ${String(res.status)})`);
      const body = await res.json();
      if (!body || body.ok !== true) throw new Error(String((body && body.error) || '读取失败'));
      return Array.isArray(body.memories) ? body.memories : [];
    }

    async function apiAdd(text, tags) {
      const res = await fetch(`${API_BASE}/memories`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ text, tags }),
      });
      if (!res.ok) throw new Error(`添加失败 (HTTP ${String(res.status)})`);
      const body = await res.json();
      if (!body || body.ok !== true) throw new Error(String((body && body.error) || '添加失败'));
      return body.entry;
    }

    async function apiRemove(id) {
      const res = await fetch(`${API_BASE}/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`删除失败 (HTTP ${String(res.status)})`);
      const body = await res.json();
      if (!body || body.ok !== true) throw new Error(String((body && body.error) || '删除失败（条目可能不存在）'));
    }

    function MemorySettingsPage() {
      const [memories, setMemories] = React.useState(null);
      const [draft, setDraft] = React.useState('');
      const [draftTags, setDraftTags] = React.useState('');
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [loaded, setLoaded] = React.useState(false);

      const refresh = React.useCallback(async () => {
        try {
          const list = await apiList();
          setMemories(list);
          setError('');
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setLoaded(true);
        }
      }, []);

      React.useEffect(() => { void refresh(); }, [refresh]);

      async function addEntry() {
        const text = draft.trim();
        if (!text || busy) return;
        setBusy(true);
        try {
          const tags = draftTags.split(/[,，;；\s]+/).map(tag => tag.trim()).filter(Boolean);
          await apiAdd(text, tags);
          setDraft('');
          setDraftTags('');
          await refresh();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      }

      async function removeEntry(id) {
        if (busy) return;
        setBusy(true);
        try {
          await apiRemove(id);
          await refresh();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      }

      const surface = 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.08))';
      const border = 'var(--dsw-alias-border-l1, rgba(128,128,128,0.25))';
      const textPrimary = 'var(--dsw-alias-label-primary, inherit)';
      const textSecondary = 'var(--dsw-alias-label-secondary, rgba(128,128,128,0.9))';
      const brand = 'var(--dsw-alias-brand-primary, #4c7dd0)';

      const inputStyle = {
        width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
        border: `1px solid ${border}`, background: surface, color: textPrimary,
        fontSize: 13, lineHeight: '20px', outline: 'none', resize: 'vertical',
      };
      const secondaryButtonStyle = {
        flex: 'none', padding: '6px 12px', borderRadius: 8, border: `1px solid ${border}`,
        background: 'transparent', color: textPrimary, fontSize: 13, cursor: 'pointer',
      };
      const primaryButtonStyle = {
        ...secondaryButtonStyle,
        background: brand, borderColor: brand, color: '#fff',
      };

      const rows = memories === null ? [] : memories;

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 640 } },
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          React.createElement('div', { style: { fontSize: 13, color: textSecondary } },
            '长期记忆库：这里的每一条记忆都会注入 Agent 的系统提示词，跨会话生效。',
          ),
          React.createElement('div', { style: { fontSize: 12, color: textSecondary, opacity: 0.75 } },
            '数据保存在 DSH_HOME/destinywind-memory/memory.json',
          ),
        ),

        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          React.createElement('textarea', {
            value: draft,
            placeholder: '添加一条记忆，例如：我的主力编程语言是 Python，代码注释用中文。',
            rows: 3,
            maxLength: 8000,
            style: inputStyle,
            onChange: event => setDraft(event.target.value),
          }),
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            React.createElement('input', {
              value: draftTags,
              placeholder: '标签（可选，逗号分隔）',
              style: { ...inputStyle, flex: 1, resize: 'none' },
              onChange: event => setDraftTags(event.target.value),
            }),
            React.createElement('button', {
              type: 'button', style: primaryButtonStyle, disabled: busy,
              onClick: () => { void addEntry(); },
            }, busy ? '保存中…' : '添加记忆'),
          ),
          error ? React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary, #c0392b)', fontSize: 12 } }, error) : null,
        ),

        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          React.createElement('div', { style: { fontSize: 12, color: textSecondary } },
            `已有记忆（${memories === null ? '…' : rows.length} 条）`,
          ),
          loaded && rows.length === 0
            ? React.createElement('div', { style: { fontSize: 13, color: textSecondary, padding: '12px 0' } }, '还没有记忆，添加第一条吧。')
            : rows.map(entry => React.createElement('div', {
                key: entry.id,
                style: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, background: surface, border: `1px solid ${border}` },
              },
                React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                  React.createElement('div', { style: { fontSize: 13, color: textPrimary, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, entry.text),
                  React.createElement('div', { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' } },
                    (entry.tags || []).map(tag => React.createElement('span', {
                      key: tag,
                      style: { fontSize: 11, padding: '1px 8px', borderRadius: 999, border: `1px solid ${border}`, color: textSecondary },
                    }, tag)),
                    React.createElement('span', { style: { fontSize: 11, color: textSecondary, opacity: 0.7 } },
                      new Date(entry.createdAt).toLocaleString(),
                    ),
                  ),
                ),
                React.createElement('button', {
                  type: 'button', style: secondaryButtonStyle, disabled: busy,
                  onClick: () => { void removeEntry(entry.id); },
                }, '删除'),
              )),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject(
          SLOT_NAME,
          () => ctx.slots.register(
            { name: SLOT_NAME, id: ENTRY_ID, order: SLOT_ORDER, label: '记忆' },
            MemorySettingsPage,
          ),
        ), 'dsh-destinywind-memory: settings section slot');
      },
    };
  },
});
