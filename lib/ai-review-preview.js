/* @caihua/dsh-doc-review — AI 审查功能预览区（v0.8）
 *
 * 三张能力卡片：划词批注 / AI 逐条回应 / 改稿落盘。
 * 纯 React.createElement，零依赖，零构建，跟随 DESIGN.md 设计系统。
 */
console.log('[dsh-doc-review] ai-review-preview v0.8.0')
window.__ModuleLoader__.load({
  id: '@caihua/dsh-doc-review/ai-review-preview',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState

    var TEXT_PRIMARY = '#f7f8f8'
    var TEXT_SECONDARY = '#d0d6e0'
    var TEXT_MUTED = '#8a8f98'
    var BRAND_ACCENT = '#7170ff'
    var PANEL_DARK = '#0f1011'
    var LEVEL3 = '#191a1b'
    var BORDER = 'rgba(255,255,255,0.08)'
    var BORDER_SUBTLE = 'rgba(255,255,255,0.05)'
    var FONT = "'Inter Variable', 'SF Pro Display', -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif"
    var MONO = "'Berkeley Mono', ui-monospace, 'SF Mono', Menlo, monospace"

    var CARDS = [
      {
        key: 'select',
        step: '01',
        title: '划词即批注',
        body: '在文档里选中任意一段，右侧写下意见。批注落盘为 sidecar，跟文档走，换机器也不丢。',
      },
      {
        key: 'respond',
        step: '02',
        title: 'AI 逐条回应',
        body: '攒够一批一次性交给 AI，它按批注逐条回应并改稿，不会在你没写完之前抢跑。',
      },
      {
        key: 'apply',
        step: '03',
        title: '改稿可回溯',
        body: '每处改动都带原文锚点。文档顶部被改过也能重新定位，接受或拒绝由你拍板。',
      },
    ]

    function FeatureCard(props) {
      var hoverState = useState(false), hovered = hoverState[0], setHovered = hoverState[1]
      var card = props.card
      var style = {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '24px',
        borderRadius: '10px',
        background: hovered ? LEVEL3 : PANEL_DARK,
        border: '1px solid ' + (hovered ? BORDER : BORDER_SUBTLE),
        transition: 'background 0.15s ease, border-color 0.15s ease',
        textAlign: 'left',
        minWidth: '0',
      }
      return h('div', {
        onMouseEnter: function () { setHovered(true) },
        onMouseLeave: function () { setHovered(false) },
        style: style,
      },
        h('div', {
          style: {
            fontFamily: MONO,
            fontSize: '12px',
            fontWeight: 400,
            color: BRAND_ACCENT,
            letterSpacing: '0.04em',
          },
        }, card.step),
        h('div', {
          style: {
            fontFamily: FONT,
            fontFeatureSettings: "'cv01', 'ss03'",
            fontWeight: 510,
            fontSize: '17px',
            lineHeight: 1.3,
            letterSpacing: '-0.01em',
            color: TEXT_PRIMARY,
          },
        }, card.title),
        h('p', {
          style: {
            margin: 0,
            fontFamily: FONT,
            fontFeatureSettings: "'cv01', 'ss03'",
            fontWeight: 400,
            fontSize: '14px',
            lineHeight: 1.6,
            letterSpacing: '-0.005em',
            color: TEXT_SECONDARY,
          },
        }, card.body)
      )
    }

    function AiReviewPreview(props) {
      var items = (props && props.cards) || CARDS
      return h('section', {
        'aria-label': 'AI 审查能力预览',
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: '24px',
          padding: '64px 32px',
          maxWidth: '1080px',
          margin: '0 auto',
          width: '100%',
          boxSizing: 'border-box',
        },
      },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('div', {
            style: {
              fontFamily: MONO,
              fontSize: '12px',
              fontWeight: 400,
              color: TEXT_MUTED,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            },
          }, 'How it works'),
          h('h2', {
            style: {
              margin: 0,
              fontFamily: FONT,
              fontFeatureSettings: "'cv01', 'ss03'",
              fontWeight: 590,
              fontSize: '28px',
              lineHeight: 1.2,
              letterSpacing: '-0.022em',
              color: TEXT_PRIMARY,
            },
          }, '三步把文档改到定稿')
        ),
        h('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: '16px',
          },
        }, items.map(function (c) { return h(FeatureCard, { key: c.key, card: c }) }))
      )
    }

    exports.AiReviewPreview = AiReviewPreview
    exports.FeatureCard = FeatureCard
    return module.exports
  },
})
