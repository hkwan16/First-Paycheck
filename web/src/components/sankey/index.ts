/** The cash-flow diagram: layout, interaction and the two renderings (web/CLAUDE.md, "Cash flow"). */
export { CashFlowSankey, DEFAULT_HEADINGS, type CashFlowSankeyProps } from './CashFlowSankey';
export { FlowStack, STACK_BELOW } from './FlowStack';
export {
  flowScale,
  layoutCashFlow,
  MIN_HOST_W,
  type FlowLayout,
  type FlowNode,
  type FlowScale,
} from './layout';
export { SSR_WIDTH, useContainerWidth } from './useContainerWidth';
