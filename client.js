window.__ModuleLoader__.load({
  id: '@local/dsh-session-delete',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const jsxRuntime = require('react/jsx-runtime');

    const NS = 'session-delete';
    const ROUTE = '/api/dsh-session-delete';

    /**
     * Menu-row styles.
     *
     * Class names are ours (`dsh-session-delete-*`), but the rules mirror the
     * host's own menu row so the entry sits in the menu like a native item:
     * same min-height/padding/gap and the same `--dsw-alias-*` theme tokens.
     * Only tokens are shared, never another plugin's stylesheet.
     */
    const MENU_CSS = [
      '.dsh-session-delete-row{position:relative}',
      '.dsh-session-delete-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;',
      'border:none;border-radius:var(--dsw-radius-md,6px);background:transparent;cursor:pointer;font:inherit;',
      'font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary,#e5484d);text-align:left}',
      '.dsh-session-delete-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,72,77,.12))}',
      '.dsh-session-delete-item:focus-visible:not(:disabled){outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#3b82f6);outline-offset:-2px}',
      '.dsh-session-delete-item:disabled{cursor:default;opacity:.6}',
      '.dsh-session-delete-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;',
      'color:var(--dsw-alias-menu-icon,currentColor)}',
      '.dsh-session-delete-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-session-delete-error{margin:0 8px 6px;font-size:12px;line-height:16px;color:var(--dsw-alias-state-error-primary,#e5484d)}',
    ].join('');

    /** Trash icon matching the host's outline icon weight (stroke = currentColor). */
    function TrashIcon(props) {
      const size = props?.size ?? 14;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'M3 4.5h10' }),
        h('path', { d: 'M6.5 4.5V3.4c0-.5.4-.9.9-.9h1.2c.5 0 .9.4.9.9v1.1' }),
        h('path', { d: 'M4.4 4.5l.6 7.6c.05.6.55 1 1.15 1h3.7c.6 0 1.1-.4 1.15-1l.6-7.6' }),
        h('path', { d: 'M6.6 6.9v4.2M9.4 6.9v4.2' }),
      );
    }

    /**
     * Ask the Host to remove one conversation's stored log and cache row.
     *
     * Same-origin fetch carries the GUI's HttpOnly session cookie, so the
     * authenticated Host route accepts it without any token plumbing here.
     *
     * @param sessionId - exact conversation id.
     * @returns the Host's JSON result (never throws for an HTTP-level failure).
     */
    async function requestDelete(sessionId) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      try {
        return await response.json();
      } catch {
        return { ok: false, code: 'bad-response', message: `HTTP ${response.status}` };
      }
    }

    /**
     * One `sidebar.workspaces.session.menu.item` row: delete this conversation.
     *
     * Receives the row identity (`sessionId`, `displayTitle`) from the owner,
     * the slot-level `useMenuOpenState` hook, and the injected
     * `refreshSessions` / `t` face. Renders exactly one `role="menuitem"`
     * button, so the host menu's own keyboard walk picks it up.
     */
    function DeleteSessionMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, refreshSessions, t } = props;
      const [, setMenuOpen] = useMenuOpenState();
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      const onSelect = React.useCallback(async () => {
        setError(null);
        const label = typeof displayTitle === 'string' && displayTitle.length > 0 ? displayTitle : sessionId;
        if (!window.confirm(t('confirm', { title: label }))) return;
        setBusy(true);
        try {
          const result = await requestDelete(sessionId);
          if (result?.ok !== true) {
            setError(result?.message ?? t('failed'));
            return;
          }
          setMenuOpen(false);
          await refreshSessions();
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
          setBusy(false);
        }
      }, [sessionId, displayTitle, setMenuOpen, refreshSessions, t]);

      return jsxRuntime.jsxs('div', {
        className: 'dsh-session-delete-row',
        children: [
          jsxRuntime.jsxs('button', {
            type: 'button',
            role: 'menuitem',
            className: 'dsh-session-delete-item',
            disabled: busy,
            onClick: onSelect,
            children: [
              jsxRuntime.jsx('span', { className: 'dsh-session-delete-icon', children: jsxRuntime.jsx(TrashIcon, {}) }),
              jsxRuntime.jsx('span', {
                className: 'dsh-session-delete-label',
                children: busy ? t('deleting') : t('label'),
              }),
            ],
          }),
          error !== null
            ? jsxRuntime.jsx('div', { className: 'dsh-session-delete-error', role: 'alert', children: error })
            : null,
        ],
      });
    }

    /** Chinese dictionary (the GUI's default locale). */
    const zh = {
      label: '删除对话',
      deleting: '正在删除…',
      confirm: '确定要删除「{title}」吗？该对话的本地记录会被永久删除，无法恢复。',
      failed: '删除失败，请重试。',
    };
    /** English dictionary. Both shipped locales are required by the locale service. */
    const en = {
      label: 'Delete conversation',
      deleting: 'Deleting…',
      confirm: 'Delete "{title}"? Its stored log is removed permanently and cannot be restored.',
      failed: 'Delete failed. Please retry.',
    };

    const inject = ['slots', 'sessions', 'locale'];

    /**
     * Register the dictionary, the menu-row style, and the menu row itself.
     * @param ctx - Client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-delete: dictionaries');
      ctx.effect(() => insertStyle(MENU_CSS), 'session-delete: menu-row style');

      const refreshSessions = () => ctx.sessions.refresh();
      const bindLocale = () => ctx.locale.bind(NS);

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'session-delete',
            order: 500,
            locale: NS,
            inject: () => ({ refreshSessions, t: bindLocale() }),
          },
          DeleteSessionMenuItem,
        ),
      );
    }

    /**
     * Append the plugin's stylesheet once per page and return its disposer.
     * @param css - stylesheet text.
     * @returns cleanup that removes the tag.
     */
    function insertStyle(css) {
      const tag = document.createElement('style');
      tag.dataset.plugin = '@local/dsh-session-delete';
      tag.textContent = css;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }

    return { apply, inject };
  },
});
