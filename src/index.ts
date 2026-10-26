/** 包入口:默认导出 `WorldDefinition`,加载器按 `cortico.kind === 'world'` 认它。 */
import { SYSMON } from './definition.ts';

export default SYSMON;
export { SYSMON };
export type { SysmonConfigSection } from './config.ts';
