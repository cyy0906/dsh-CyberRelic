/**
 * dsh-sync-fish —— 设置页（浏览器端）
 *
 * client bundle 不是 ESM，是自注册脚本：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => {...} })
 * 页面挂在「设置 › 跨设备同步」，数据走宿主挂的 /api/sync-fish。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sync-fish',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const API = '/api/sync-fish'

    async function asJson(res) {
      let data = null
      try {
        data = await res.json()
      } catch {
        data = null
      }
      if (!res.ok) {
        const message = data && data.message ? data.message : `HTTP ${res.status}`
        throw new Error(message)
      }
      return data
    }
    const timeoutSignal = (ms) => {
      try {
        return AbortSignal.timeout(ms)
      } catch {
        return undefined
      }
    }
    // 把页面里发生的事写到宿主日志：设置页出问题时不用让主人开 F12 猜
    function diag(stage, extra) {
      try {
        const payload = JSON.stringify({
          stage,
          href: String(location.href).slice(0, 160),
          origin: location.origin,
          ua: navigator.userAgent.slice(0, 120),
          ...extra,
        })
        if (navigator.sendBeacon) {
          navigator.sendBeacon(API + '/diag', new Blob([payload], { type: 'application/json' }))
        }
      } catch {
        /* 自检本身不能把页面搞挂 */
      }
    }
    const jget = async (path) => {
      const res = await fetch(API + path, { credentials: 'same-origin', signal: timeoutSignal(10_000) })
      return asJson(res)
    }
    const jpost = async (path, body) =>
      asJson(
        await fetch(API + path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        }),
      )

    const SCOPES = [
      ['memory', '记忆', '鱼记忆的全局库，跟着账号走'],
      ['skills', '习惯 / 技能', '~/.dsh/skills 下的技能文件'],
      ['plugins', '插件设置', '其它插件的 *-config.json'],
      ['tasks', '任务', '定时任务的 schedule.json'],
      ['workspaces', '工作区', '工作区列表（路径和会话不跨机，默认关）'],
    ]

    const css = `
.sf-page { padding: 8px 4px 40px; max-width: 780px; font-size: 13px; }
.sf-hero { border: 1px solid var(--border, #2a3242); border-radius: 12px; padding: 14px 16px; margin-bottom: 14px; background: var(--panel, rgba(255,255,255,0.02)); }
.sf-hero h2 { margin: 0 0 6px; font-size: 16px; }
.sf-hero p { margin: 0; opacity: .72; line-height: 1.6; }
.sf-card { border: 1px solid var(--border, #2a3242); border-radius: 12px; padding: 14px 16px; margin-bottom: 14px; }
.sf-card h3 { margin: 0 0 10px; font-size: 14px; display: flex; align-items: center; gap: 8px; }
.sf-card h3 small { font-weight: 400; opacity: .55; }
.sf-row { display: flex; gap: 10px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
.sf-row > label { min-width: 92px; opacity: .75; }
.sf-input, .sf-select { flex: 1; min-width: 180px; padding: 7px 9px; border-radius: 8px; border: 1px solid var(--border, #2a3242); background: var(--bg, rgba(0,0,0,0.2)); color: inherit; font-size: 13px; }
.sf-btn { padding: 7px 13px; border-radius: 8px; border: 1px solid var(--border, #2a3242); background: var(--panel, rgba(255,255,255,0.04)); color: inherit; cursor: pointer; font-size: 13px; }
.sf-btn:hover { filter: brightness(1.15); }
.sf-btn:disabled { opacity: .5; cursor: not-allowed; }
.sf-btn.primary { background: #3b6cff; border-color: #3b6cff; color: #fff; }
.sf-btn.danger { border-color: #a33; color: #e88; }
.sf-check { display: flex; gap: 8px; align-items: flex-start; margin: 6px 0; }
.sf-check input { margin-top: 2px; }
.sf-check b { font-weight: 600; }
.sf-check span { display: block; opacity: .6; font-size: 12px; }
.sf-note { opacity: .62; line-height: 1.6; margin: 6px 0 0; }
.sf-warn { color: #e0a33a; }
.sf-ok { color: #4fbf7a; }
.sf-err { color: #e06a6a; }
.sf-pill { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border, #2a3242); font-size: 12px; opacity: .9; }
.sf-log { white-space: pre-wrap; font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.55; background: rgba(0,0,0,0.22); border-radius: 8px; padding: 10px; margin-top: 8px; max-height: 240px; overflow: auto; }
.sf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px 16px; }
.sf-toast { margin: 8px 0 0; line-height: 1.6; }
`

    function Field(props) {
      return h(
        'div',
        { className: 'sf-row' },
        h('label', null, props.label),
        props.children,
        props.hint ? h('span', { className: 'sf-note' }, props.hint) : null,
      )
    }

    function Toggle({ checked, onChange, label, detail }) {
      return h(
        'label',
        { className: 'sf-check' },
        h('input', { type: 'checkbox', checked: Boolean(checked), onChange: (event) => onChange(event.target.checked) }),
        h('span', null, h('b', null, label), detail ? h('span', null, detail) : null),
      )
    }

    function Panel() {
      const [status, setStatus] = useState(null)
      const [form, setForm] = useState(null)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [job, setJob] = useState(null)

      const applyStatus = useCallback((data) => {
        diag('apply:enter', { hasData: Boolean(data), hasConfig: Boolean(data && data.config) })
        setStatus(data)
        const config = data?.config
        if (!config) {
          diag('apply:no-config')
          setNotice('接口返回里没有 config（宿主插件版本可能过旧），请在宿主重启后再试。')
          return
        }
        setForm((previous) => {
          const base = {
            enabled: config.enabled,
            deviceName: config.deviceName || '',
            channelType: config.channel?.type || 'webdav',
            url: config.channel?.url || '',
            root: config.channel?.root || '',
            username: config.channel?.username || '',
            prefix: config.channel?.prefix || '',
            password: '',
            hasPassword: Boolean(config.channel?.hasPassword),
            passphrase: '',
            encrypted: Boolean(config.encrypted),
            scopes: { ...(config.scopes || {}) },
            intervalMinutes: config.intervalMinutes ?? 30,
            syncOnStart: config.syncOnStart !== false,
            debounceSeconds: config.debounceSeconds ?? 120,
            phoneName: config.phone?.deviceName || '手机',
            adbPath: config.phone?.adbPath || '',
          }
          if (!previous) return base
          // 只同步「从宿主来的」字段，别把用户正在输入的内容冲掉
          return {
            ...previous,
            enabled: base.enabled,
            deviceName: base.deviceName,
            hasPassword: base.hasPassword,
            encrypted: base.encrypted,
            scopes: base.scopes,
          }
        })
      }, [])

      const refresh = useCallback(async () => {
        diag('refresh:start')
        // 老版本 Chromium 没有 AbortSignal.timeout，用 AbortController 兜底
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const timer = controller ? setTimeout(() => controller.abort(), 10_000) : null
        try {
          const res = await fetch(`${API}/status`, {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller ? controller.signal : undefined,
          })
          diag('status:response', { status: res.status, ok: res.ok })
          const data = await res.json()
          diag('status:parsed', {
            type: data === null ? 'null' : typeof data,
            keys: data && typeof data === 'object' ? Object.keys(data).join(',').slice(0, 120) : '',
            hasStatus: Boolean(data && data.status),
            hasConfig: Boolean(data && data.status && data.status.config),
          })
          applyStatus(data.status)
          diag('status:applied')
          setNotice('')
        } catch (error) {
          console.error('[sync-fish] 读状态失败', error)
          diag('status:error', { message: String(error && error.message).slice(0, 200) })
          setNotice(`读状态失败：${error.message}（接口 ${API}/status）`)
        } finally {
          if (timer) clearTimeout(timer)
        }
      }, [applyStatus])

      useEffect(() => {
        diag('mount')
        void refresh()
      }, [refresh])

      useEffect(() => {
        const style = document.createElement('style')
        style.textContent = css
        document.head.appendChild(style)
        return () => style.remove()
      }, [])

      // 手机安装任务轮询
      useEffect(() => {
        if (!job || !job.id || job.status !== 'running') return undefined
        const timer = setInterval(async () => {
          try {
            const data = await jget(`/phone/install?id=${encodeURIComponent(job.id)}`)
            setJob(data.job)
            if (data.job.status !== 'running') void refresh()
          } catch (error) {
            setJob((previous) => ({ ...previous, error: error.message }))
          }
        }, 2000)
        return () => clearInterval(timer)
      }, [job, refresh])

      const save = useCallback(
        async (thenTest) => {
          if (!form) return
          setBusy(thenTest ? 'test' : 'save')
          setNotice('')
          try {
            const channel = {
              type: form.channelType,
              url: form.url,
              root: form.root,
              username: form.username,
              prefix: form.prefix,
              clearPassword: false,
            }
            if (form.password) channel.password = form.password
            const patch = {
              enabled: form.enabled,
              deviceName: form.deviceName,
              intervalMinutes: Number(form.intervalMinutes) || 0,
              syncOnStart: form.syncOnStart,
              debounceSeconds: Number(form.debounceSeconds) || 120,
              scopes: form.scopes,
              channel,
              phone: { deviceName: form.phoneName, adbPath: form.adbPath },
            }
            if (form.passphrase) patch.passphrase = form.passphrase
            const data = await jpost('/config', patch)
            applyStatus(data.status)
            setForm((previous) => (previous ? { ...previous, password: '', passphrase: '' } : previous))
            setNotice(data.message || '已保存')
            if (thenTest) {
              const test = await jpost('/test', {})
              const probe = test.probe
              setNotice(`${data.message}\n通道探测：${probe.ok ? '✓ 读写正常' : `✗ ${probe.error}`}`)
            }
          } catch (error) {
            setNotice(`保存失败：${error.message}`)
          } finally {
            setBusy('')
          }
        },
        [form, applyStatus],
      )

      const runSync = useCallback(async () => {
        setBusy('sync')
        setNotice('')
        try {
          const data = await jpost('/sync', {})
          setNotice(data.result?.message || (data.ok ? '同步完成' : '同步失败'))
          await refresh()
        } catch (error) {
          setNotice(`同步失败：${error.message}`)
        } finally {
          setBusy('')
        }
      }, [refresh])

      const clearConflicts = useCallback(async () => {
        try {
          const data = await jpost('/conflicts/clear', {})
          setNotice(`清掉了 ${data.cleared || 0} 条冲突记录`)
          await refresh()
        } catch (error) {
          setNotice(`清冲突失败：${error.message}`)
        }
      }, [refresh])

      const installPhone = useCallback(async () => {
        setBusy('phone')
        setNotice('')
        try {
          const data = await jpost('/phone/install', {})
          setJob({ id: data.jobId, status: 'running', log: ['已开始：正在打包并推送到手机…'] })
        } catch (error) {
          setNotice(`手机安装失败：${error.message}`)
          setBusy('')
        }
      }, [])

      const phone = status?.phone || {}
      const phoneLog = job?.log?.length ? job.log.join('\n') : job?.error || ''

      if (!form) {
        return h(
          'div',
          { className: 'sf-page' },
          h('p', { className: 'sf-note' }, notice || '正在读同步状态…'),
          h(
            'p',
            { className: 'sf-note' },
            h('button', { className: 'sf-btn', onClick: () => void refresh() }, '再试一次'),
            ` 接口：${API}/status`,
          ),
          h('p', { className: 'sf-note' }, '如果一直停在这里，按 F12 看 Console 里有没有红色错误，把内容发给主人。'),
        )
      }

      const scopeOn = form.scopes || {}

      return h(
        'div',
        { className: 'sf-page' },
        h(
          'div',
          { className: 'sf-hero' },
          h('h2', null, '跨设备同步'),
          h(
            'p',
            null,
            '电脑之间、电脑和手机（DSH Go）之间同步鱼记忆、技能、插件设置和任务。' +
              '快照加密后放进一个 WebDAV 网盘目录（或者一个本地同步文件夹），每台设备各写各的，读的时候按时间合并。',
          ),
          h(
            'div',
            { className: 'sf-row', style: { marginTop: '10px' } },
            h('span', { className: 'sf-pill' }, form.enabled ? '自动同步：开' : '自动同步：关'),
            h('span', { className: 'sf-pill' }, `通道：${form.channelType}`),
            h('span', { className: 'sf-pill' }, form.encrypted ? '加密：开' : '加密：关'),
            h('span', { className: 'sf-pill' }, `间隔：${form.intervalMinutes || 0} 分钟`),
          ),
        ),

        h(
          'div',
          { className: 'sf-card' },
          h('h3', null, '状态'),
          h(
            'div',
            { className: 'sf-row' },
            h('span', null, `设备：${status?.deviceName || '-'}（${status?.deviceId || '还没生成 id'}）`),
            h('span', null, `上次同步：${status?.lastSyncAt || '还没同步过'}`),
            status?.running ? h('span', { className: 'sf-pill' }, '正在同步…') : null,
          ),
          h(
            'div',
            { className: 'sf-row' },
            h('span', null, `其它设备：${(status?.devices || []).join('、') || '还没看到'}`),
            h('span', null, `记忆：全局 ${status?.memory?.globalRecords ?? 0} 条 / 本地 ${status?.memory?.stores ?? 0} 个库`),
            h('span', null, `待处理冲突：${status?.conflicts ?? 0} 条`),
          ),
          status?.lastError ? h('p', { className: 'sf-note sf-err' }, status.lastError) : null,
          h(
            'div',
            { className: 'sf-row' },
            h(
              'button',
              { className: 'sf-btn primary', disabled: busy === 'sync', onClick: runSync },
              busy === 'sync' ? '正在同步…' : '立即同步',
            ),
            h('button', { className: 'sf-btn', onClick: refresh }, '刷新'),
            (status?.conflicts || 0) > 0
              ? h('button', { className: 'sf-btn danger', onClick: clearConflicts }, '清空冲突记录')
              : null,
          ),
        ),

        h(
          'div',
          { className: 'sf-card' },
          h('h3', null, '连接', h('small', null, '坚果云填邮箱 + 应用密码；应用密码在网盘网页的「安全」里生成')),
          h(
            Field,
            { label: '通道' },
            h(
              'select',
              {
                className: 'sf-select',
                value: form.channelType,
                onChange: (event) => setForm({ ...form, channelType: event.target.value }),
              },
              h('option', { value: 'webdav' }, 'WebDAV 网盘（坚果云 / Nextcloud / 群晖）'),
              h('option', { value: 'folder' }, '本地同步文件夹'),
            ),
          ),
          form.channelType === 'webdav'
            ? h(
                React.Fragment,
                null,
                h(
                  Field,
                  { label: '地址' },
                  h('input', {
                    className: 'sf-input',
                    value: form.url,
                    placeholder: 'https://dav.jianguoyun.com/dav/',
                    onChange: (event) => setForm({ ...form, url: event.target.value }),
                  }),
                ),
                h(
                  Field,
                  { label: '邮箱' },
                  h('input', {
                    className: 'sf-input',
                    value: form.username,
                    placeholder: '网盘登录邮箱',
                    onChange: (event) => setForm({ ...form, username: event.target.value }),
                  }),
                ),
                h(
                  Field,
                  { label: '应用密码' },
                  h('input', {
                    className: 'sf-input',
                    type: 'password',
                    value: form.password,
                    placeholder: form.hasPassword ? '已保存，留空不修改' : '网盘里生成的「应用密码」，不是登录密码',
                    onChange: (event) => setForm({ ...form, password: event.target.value }),
                  }),
                ),
                h(
                  Field,
                  { label: '子目录' },
                  h('input', {
                    className: 'sf-input',
                    value: form.prefix,
                    placeholder: '留空 = 网盘根目录',
                    onChange: (event) => setForm({ ...form, prefix: event.target.value }),
                  }),
                ),
              )
            : h(
                Field,
                { label: '文件夹' },
                h('input', {
                  className: 'sf-input',
                  value: form.root,
                  placeholder: 'D:\\同步盘\\dsh-sync',
                  onChange: (event) => setForm({ ...form, root: event.target.value }),
                }),
              ),
          h(
            'div',
            { className: 'sf-row' },
            h(
              'button',
              { className: 'sf-btn', disabled: busy === 'test', onClick: () => save(true) },
              busy === 'test' ? '正在测试…' : '保存并测试连接',
            ),
            form.hasPassword
              ? h(
                  'button',
                  {
                    className: 'sf-btn danger',
                    onClick: async () => {
                      try {
                        const data = await jpost('/config', { channel: { clearPassword: true } })
                        applyStatus(data.status)
                        setForm({ ...form, hasPassword: false, password: '' })
                        setNotice('已清掉保存的应用密码')
                      } catch (error) {
                        setNotice(`清密码失败：${error.message}`)
                      }
                    },
                  },
                  '清掉密码',
                )
              : null,
          ),
        ),

        h(
          'div',
          { className: 'sf-card' },
          h('h3', null, '同步哪些东西'),
          h(
            'div',
            { className: 'sf-grid' },
            SCOPES.map(([key, label, detail]) =>
              h(Toggle, {
                key,
                checked: scopeOn[key] === true,
                label,
                detail,
                onChange: (value) => setForm({ ...form, scopes: { ...form.scopes, [key]: value } }),
              }),
            ),
          ),
          h('p', { className: 'sf-note' }, '加密口令对所有设备生效；关掉一个分类，本机就不再上报也不再接受这一类内容。'),
        ),

        h(
          'div',
          { className: 'sf-card' },
          h('h3', null, '节奏'),
          h(
            Field,
            { label: '自动间隔' },
            h('input', {
              className: 'sf-input',
              type: 'number',
              min: 0,
              value: form.intervalMinutes,
              onChange: (event) => setForm({ ...form, intervalMinutes: event.target.value }),
            }),
            '分钟，0 = 不自动同步',
          ),
          h(
            Field,
            { label: '新会话后' },
            h('input', {
              className: 'sf-input',
              type: 'number',
              min: 10,
              value: form.debounceSeconds,
              onChange: (event) => setForm({ ...form, debounceSeconds: event.target.value }),
            }),
            '秒后再推一次（手机后台会被杀，靠启动时同步）',
          ),
          h(Toggle, {
            label: '启动时同步',
            checked: form.syncOnStart,
            onChange: (value) => setForm({ ...form, syncOnStart: value }),
          }),
          h(Toggle, {
            label: '启用自动同步',
            checked: form.enabled,
            onChange: (value) => setForm({ ...form, enabled: value }),
          }),
        ),

        h(
          'div',
          { className: 'sf-card' },
          h('h3', null, '加密', h('small', null, '可选；设了之后网盘里只有密文')),
          h(
            Field,
            { label: '口令' },
            h('input', {
              className: 'sf-input',
              type: 'password',
              value: form.passphrase,
              placeholder: form.encrypted ? '已设置，留空不修改' : '留空 = 不加密',
              onChange: (event) => setForm({ ...form, passphrase: event.target.value }),
            }),
          ),
          h('p', { className: 'sf-note' }, '所有设备必须填同一个口令；忘了口令，网盘里的快照就打不开了（各机本地数据不受影响）。'),
          form.encrypted
            ? h(
                'button',
                {
                  className: 'sf-btn danger',
                  onClick: async () => {
                    try {
                      const data = await jpost('/config', { clearPassphrase: true })
                      applyStatus(data.status)
                      setNotice('已关闭加密：下次同步会写明文快照')
                    } catch (error) {
                      setNotice(`关闭加密失败：${error.message}`)
                    }
                  },
                },
                '关闭加密',
              )
            : null,
        ),

        h(
          'div',
          { className: 'sf-card' },
          h('h3', null, '手机', h('small', null, 'USB 连着电脑时，一键装到 DSH Go')),
          h(
            'div',
            { className: 'sf-row' },
            h('span', null, `adb：${phone.adb?.found ? phone.adb.path : '没找到（可手填路径）'}`),
            h(
              'span',
              { className: phone.adb?.devices?.length ? 'sf-ok' : 'sf-warn' },
              phone.adb?.devices?.length
                ? phone.adb.devices.map((item) => `${item.model || item.serial}（${item.state}）`).join('、')
                : '没看到手机',
            ),
          ),
          h(
            Field,
            { label: '手机名字' },
            h('input', {
              className: 'sf-input',
              value: form.phoneName,
              onChange: (event) => setForm({ ...form, phoneName: event.target.value }),
            }),
          ),
          h(
            Field,
            { label: 'adb 路径' },
            h('input', {
              className: 'sf-input',
              value: form.adbPath,
              placeholder: '留空自动找',
              onChange: (event) => setForm({ ...form, adbPath: event.target.value }),
            }),
          ),
          h(
            'div',
            { className: 'sf-row' },
            h(
              'button',
              {
                className: 'sf-btn primary',
                disabled: busy === 'phone' || form.channelType !== 'webdav',
                onClick: installPhone,
              },
              busy === 'phone' ? '正在装…' : '一键装到手机',
            ),
            h('span', { className: 'sf-note' }, form.channelType !== 'webdav' ? '手机安装需要 WebDAV 通道' : '手机要开着 USB 调试并允许这台电脑'),
          ),
          phoneLog ? h('pre', { className: 'sf-log' }, phoneLog) : null,
        ),

        h(
          'div',
          { className: 'sf-row' },
          h('button', { className: 'sf-btn primary', disabled: busy === 'save', onClick: () => save(false) }, busy === 'save' ? '保存中…' : '保存设置'),
          h('span', { className: 'sf-note' }, status?.paths?.config || ''),
        ),
        notice ? h('pre', { className: 'sf-toast sf-note' }, notice) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        slots.inject('settings.section', () =>
          slots.register({ name: 'settings.section', id: 'sync-fish', order: 40, label: '跨设备同步' }, () => h(Panel)),
        )
      },
    }
  },
})
