import { ClientAdminApprovalFlow } from '../../src/flow-engine';

// Page Object实例由测试创建并通过这些回调注入；Flow Engine不读取DOM。
export function createApprovalFlowTemplate() {
  return new ClientAdminApprovalFlow({} as never, {
    preflight: async () => {},
    captureBeforeState: async () => ({}),
    clientSubmit: async () => ({}),
    captureClientReference: async () => 'BUSINESS-ID',
    adminLocate: async () => [],
    adminVerify: async () => {},
    adminAction: async () => {},
    clientWaitFinalState: async () => ({}),
    captureAfterState: async () => ({}),
    primaryOracle: async () => {},
    secondaryOracle: async () => {},
    report: async () => {}
  });
}

