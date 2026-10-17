/* @caihua/dsh-doc-review — AI 审查功能入口 Hero 横幅
 *
 * 纯 React.createElement，零依赖，零构建。
 * 展示：AI 审查能力介绍 + 双 CTA（开始审查 / 查看示例）。
 * 设计系统：#08090a 背景 / #5e6ad2 品牌色 / Inter Variable 510 / cv01+ss03。
 */
console.log('[dsh-doc-review] ai-review-hero v0.8.0')
window.__ModuleLoader__.load({
  id: '@caihua/dsh-doc-review/ai-review-hero',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef

    var BG = '#08090a'
    var TEXT_PRIMARY = '#f7f8f8'
    var TEXT_SECONDARY = '#d0d6e0'
    var TEXT_MUTED = '#8a8f98'
    var BRAND_BG = '#5e6ad2'
    var BRAND_ACCENT = '#7170ff'
    var BRAND_HOVER = '#828fff'
    var BORDER = 'rgba(255,255,255,0.08)'
    var BORDER_SUBTLE = 'rgba(255,255,255,0.05)'
    var FONT = "'Inter Variable', 'SF Pro Display', -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif"
    var MONO = "'Berkeley Mono', ui-monospace, 'SF Mono', Menlo, monospace"

    function baseFont(weight) {
      return {
        fontFamily: FONT,
        fontFeatureSettings: "'cv01', 'ss03'",
        fontWeight: weight || 510,
      }
    }

    /* ── CTA 主按钮（品牌 indigo，含 hover/active/focus/disabled 态） ── */
    function BrandButton(props) {
      var pressedState = useState(false), pressed = pressedState[0], setPressed = pressedState[1]
      var hoverState = useState(false), hovered = hoverState[0], setHovered = hoverState[1]
      var focusState = useState(false), focused = focusState[0], setFocused = focusState[1]
      var disabled = !!props.disabled
      var style = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 16px',
        borderRadius: '6px',
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: FONT,
        fontFeatureSettings: "'cv01', 'ss03'",
        fontWeight: 510,
        fontSize: '14px',
        lineHeight: 1.5,
        color: '#ffffff',
        background: disabled ? 'rgba(255,255,255,0.04)' : (hovered ? BRAND_HOVER : BRAND_BG),
        outline: focused ? '2px solid ' + BRAND_ACCENT : 'none',
        outlineOffset: '2px',
        transition: 'background 0.15s ease, transform 0.1s ease',
        transform: pressed ? 'scale(0.97)' : 'scale(1)',
        opacity: disabled ? 0.6 : 1,
        letterSpacing: '-0.01em',
      }
      return h('button', {
        type: 'button',
        disabled: disabled,
        'aria-label': props['aria-label'],
        onMouseEnter: function () { setHovered(true) },
        onMouseLeave: function () { setHovered(false); setPressed(false) },
        onMouseDown: function () { setPressed(true) },
        onMouseUp: function () { setPressed(false) },
        onFocus: function () { setFocused(true) },
        onBlur: function () { setFocused(false) },
        onClick: disabled ? null : props.onClick,
        style: style,
      }, props.children)
    }

    /* ── Ghost 幽灵按钮 ── */
    function GhostButton(props) {
      var hoverState = useState(false), hovered = hoverState[0], setHovered = hoverState[1]
      var focusState = useState(false), focused = focusState[0], setFocused = focusState[1]
      var style = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 16px',
        borderRadius: '6px',
        border: '1px solid rgba(255,255,255,0.08)',
        cursor: 'pointer',
        fontFamily: FONT,
        fontFeatureSettings: "'cv01', 'ss03'",
        fontWeight: 510,
        fontSize: '14px',
        lineHeight: 1.5,
        color: '#e2e4e7',
        background: hovered ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)',
        outline: focused ? '2px solid ' + BRAND_ACCENT : 'none',
        outlineOffset: '2px',
        transition: 'background 0.15s ease, border-color 0.15s ease',
        letterSpacing: '-0.01em',
      }
      return h('button', {
        type: 'button',
        'aria-label': props['aria-label'],
        onMouseEnter: function () { setHovered(true) },
        onMouseLeave: function () { setHovered(false) },
        onFocus: function () { setFocused(true) },
        onBlur: function () { setFocused(false) },
        onClick: props.onClick,
        style: style,
      }, props.children)
    }

    /* ── 装饰性光晕（用 CSS 渐变模拟品牌光晕，零外部图片） ── */
    function GlowOrbs() {
      return h('div', {
        'aria-hidden': 'true',
        style: {
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          pointerEvents: 'none',
        },
      },
        h('div', { style: {
          position: 'absolute',
          top: '-40%',
          left: '20%',
          width: '600px',
          height: '600px',
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(94,106,210,0.14) 0%, rgba(94,106,210,0.04) 40%, transparent 70%)',
          filter: 'blur(80px)',
        } }),
        h('div', { style: {
          position: 'absolute',
          bottom: '-30%',
          right: '10%',
          width: '480px',
          height: '480px',
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(113,112,255,0.10) 0%, rgba(113,112,255,0.02) 40%, transparent 70%)',
          filter: 'blur(100px)',
        } })
      )
    }

    /* ── Hero 横幅主组件 ── */
    function AiReviewHero(props) {
      var startedState = useState(false), started = startedState[0], setStarted = startedState[1]
      var cueRef = useRef(null)

      useEffect(function () {
        // 入场提示：聚焦到 CTA 区域（无障碍）
        if (cueRef.current && props.autoFocusCue) {
          cueRef.current.focus()
        }
      }, [])

      var sectionStyle = {
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        minHeight: '420px',
        padding: '64px 32px',
        background: BG,
        overflow: 'hidden',
      }

      var contentStyle = {
        position: 'relative',
        zIndex: 1,
        maxWidth: '720px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '24px',
      }

      var badgeStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 10px',
        borderRadius: '9999px',
        border: '1px solid ' + BORDER,
        background: 'rgba(255,255,255,0.03)',
        fontFamily: MONO,
        fontSize: '11px',
        fontWeight: 400,
        color: BRAND_ACCENT,
        letterSpacing: '0.02em',
      }

      var titleStyle = Object.assign({}, baseFont(510), {
        fontSize: '48px',
        lineHeight: 1.0,
        letterSpacing: '-1.056px',
        color: TEXT_PRIMARY,
        margin: 0,
      })

      var subtitleStyle = Object.assign({}, baseFont(400), {
        fontSize: '18px',
        lineHeight: 1.6,
        color: TEXT_SECONDARY,
        margin: 0,
        maxWidth: '560px',
      })

      var ctaRowStyle = {
        display: 'flex',
        gap: '12px',
        flexWrap: 'wrap',
        justifyContent: 'center',
        marginTop: '8px',
      }

      var hintStyle = {
        fontFamily: MONO,
        fontSize: '12px',
        color: TEXT_MUTED,
        letterSpacing: '0.02em',
      }

      return h('section', {
        'aria-label': 'AI 审查功能入口',
        style: sectionStyle,
        ref: cueRef,
        tabIndex: props.autoFocusCue ? -1 : undefined,
      },
        h(GlowOrbs),
        h('div', { style: contentStyle },
          h('div', { style: badgeStyle }, '◆ AI 审查 · v0.8'),
          h('h1', { style: titleStyle }, '文档审查，让 AI 第一次读懂你的意图'),
          h('p', { style: subtitleStyle },
            '基于批注挖掘与规则引擎的预审能力，在改动提案落盘前先给出结构化建议，',
            '每一条都带着出处与理由，人确认后才真正生效。'
          ),
          h('div', { style: ctaRowStyle },
            h(BrandButton, {
              'aria-label': '开始 AI 审查',
              onClick: function () { setStarted(true); if (props.onStart) props.onStart() },
            }, '开始审查'),
            h(GhostButton, {
              'aria-label': '查看 AI 审查示例',
              onClick: props.onDemo,
            }, '查看示例')
          ),
          started
            ? h('div', {
                role: 'status',
                'aria-live': 'polite',
                style: {
                  padding: '10px 16px',
                  borderRadius: '8px',
                  background: 'rgba(94,106,210,0.10)',
                  border: '1px solid rgba(94,106,210,0.25)',
                  color: BRAND_ACCENT,
                  fontFamily: FONT,
                  fontFeatureSettings: "'cv01', 'ss03'",
                  fontWeight: 510,
                  fontSize: '14px',
                },
              }, '审查请求已提交，正在分析文档结构…')
            : null,
          h('div', { style: hintStyle }, '按 ' + (typeof navigator !== 'undefined' && navigator.platform ? 'Cmd' : 'Ctrl') + '+K 唤起命令面板')
        )
      )
    }

    exports.AiReviewHero = AiReviewHero
    exports.BrandButton = BrandButton
    exports.GhostButton = GhostButton
    return module.exports
  },
})
