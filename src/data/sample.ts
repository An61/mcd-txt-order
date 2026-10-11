/**
 * 内置示例数据 —— **仅供离线演示**（T9）。
 *
 * ⚠️ 重要说明：
 * 1. 菜单和价格来自本地探针快照；门店名称、编码、地址和距离是合成示例，
 *    不代表任何真实门店或实时营业状态。
 * 2. 它不是官方发布的数据源。真实使用时一律以 `query-meals` 与 `query-nearby-stores`
 *    的实时返回为准，本文件仅服务于「没有 Token 也能跑通演示」这一个目的。
 * 3. **不含任何凭据**（无 Token、无配送地址、无账号信息），可安全随仓库分发。
 *
 * 用途：没有 MCP Token 时，`npm run demo` 依然能完整走完
 * 「输入 → 门店命中 → 菜单匹配 → 预览 → 确认 → 支付链接（示例）」的链路，
 * 让评审者 clone 下来就能玩。
 *
 * 本文件由 `scripts/gen-sample.ts` 生成，**请勿手工编辑**。
 * 生成时间：2026-10-10T02:48:47.080Z
 */

import { hasPrice, yuanToCents, type Menu, type MenuCategory, type MenuItem, type Store } from '../domain/types.ts';
import { parseMealDetail } from '../mcp/normalize.ts';
import type { ParseNutritionResult } from '../mcp/nutrition.ts';

// ─────────────────────────────────────────────────────────────
// 门店
// ─────────────────────────────────────────────────────────────

export interface SampleStoreRow {
  readonly code: string;
  readonly name: string;
  readonly address: string;
  readonly distance: number;
  readonly city: string;
  readonly open: boolean;
  readonly openTime: string;
  readonly closeTime: string;
}

const SAMPLE_STORE_ROWS: readonly SampleStoreRow[] = [
  { code: 'DEMO-STORE-001', name: '示例星河餐厅', address: '示例星河大道 1 号', distance: 120, city: '示例市', open: true, openTime: '06:00', closeTime: '23:00' },
  { code: 'DEMO-STORE-002', name: '示例云杉餐厅', address: '示例云杉路 2 号', distance: 480, city: '示例市', open: true, openTime: '06:30', closeTime: '23:30' },
  { code: 'DEMO-STORE-003', name: '示例晨曦餐厅', address: '示例晨曦街 3 号', distance: 860, city: '示例市', open: true, openTime: '07:00', closeTime: '22:30' },
  { code: 'DEMO-STORE-004', name: '示例湖畔餐厅', address: '示例湖畔路 4 号', distance: 1250, city: '示例市', open: true, openTime: '07:30', closeTime: '22:00' },
  { code: 'DEMO-STORE-005', name: '示例松风餐厅', address: '示例松风路 5 号', distance: 1600, city: '示例市', open: true, openTime: '08:00', closeTime: '21:30' },
];

export const SAMPLE_STORES: readonly Store[] = SAMPLE_STORE_ROWS.map((row) => ({
  code: row.code,
  name: row.name,
  address: row.address,
  distanceMeters: row.distance,
  city: row.city,
  open: row.open,
  businessStartTime: row.openTime,
  businessEndTime: row.closeTime,
  supportsReservation: true,
}));

/** 演示默认门店：与 config/favorites.example.json 里的「示例星河」对应 */
export const SAMPLE_DEFAULT_STORE_CODE = 'DEMO-STORE-001';

// ─────────────────────────────────────────────────────────────
// 菜单
// ─────────────────────────────────────────────────────────────

interface SampleItemRow {
  readonly code: string;
  readonly name: string;
  /** 「元」的字符串，与 `query-meals` 的原始形态保持一致 */
  readonly yuan: string;
  readonly originalYuan: string;
  readonly tags: readonly string[];
  readonly cats: readonly string[];
  readonly canWithOrder: boolean;
}

const SAMPLE_ITEM_ROWS: readonly SampleItemRow[] = [
  { code: '1100', name: '巨无霸', yuan: '26.5', originalYuan: '26.5', tags: ['单品', '100%纯牛肉'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: false },
  { code: '1106', name: '培根蔬萃双层牛堡', yuan: '24.5', originalYuan: '24.5', tags: ['单品', '100%纯牛肉'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: false },
  { code: '1120', name: '双层吉士汉堡', yuan: '23', originalYuan: '23', tags: ['单品', '100%纯牛肉'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: false },
  { code: '1401', name: '麦乐鸡', yuan: '14', originalYuan: '14', tags: ['单品', '人气'], cats: ['炸鸡'], canWithOrder: false },
  { code: '1406', name: '板烧鸡腿堡', yuan: '23.5', originalYuan: '23.5', tags: ['单品', '板烧滋滋', '多汁惹味'], cats: ['鸡肉汉堡\n/卷'], canWithOrder: false },
  { code: '1440', name: '麦辣鸡腿汉堡', yuan: '22.5', originalYuan: '22.5', tags: ['单品', '人气经典', '外酥里嫩'], cats: ['鸡肉汉堡\n/卷'], canWithOrder: false },
  { code: '1450', name: '麦香鸡', yuan: '17', originalYuan: '17', tags: ['单品'], cats: ['鸡肉汉堡\n/卷'], canWithOrder: false },
  { code: '1600', name: '麦香鱼', yuan: '22.5', originalYuan: '22.5', tags: ['单品', '麦香鱼系列'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: false },
  { code: '1700', name: '麦辣鸡翅', yuan: '14.5', originalYuan: '14.5', tags: ['单品', '黄金酥脆', '鲜嫩多汁'], cats: ['炸鸡'], canWithOrder: false },
  { code: '2430', name: '【美汁源】“黄金橙橙”', yuan: '13', originalYuan: '13', tags: ['冷饮'], cats: ['饮品'], canWithOrder: false },
  { code: '3010', name: '雪碧', yuan: '9.5', originalYuan: '9.5', tags: ['冷饮'], cats: ['饮品'], canWithOrder: false },
  { code: '3505', name: '锡兰红茶', yuan: '10.5', originalYuan: '10.5', tags: ['热饮'], cats: ['饮品'], canWithOrder: false },
  { code: '3755', name: '纯牛奶(盒装)', yuan: '10.5', originalYuan: '10.5', tags: ['冷饮'], cats: ['饮品'], canWithOrder: false },
  { code: '3757', name: '纯悦', yuan: '7.5', originalYuan: '7.5', tags: ['冷饮'], cats: ['饮品'], canWithOrder: false },
  { code: '4437', name: '玉米杯', yuan: '13', originalYuan: '13', tags: ['小食'], cats: ['小食甜品\n/其他'], canWithOrder: false },
  { code: '4648', name: '不素之霸双层牛堡', yuan: '26.5', originalYuan: '26.5', tags: ['单品', '100%纯牛肉'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: false },
  { code: '4810', name: '薯条', yuan: '14', originalYuan: '14', tags: ['小食'], cats: ['小食甜品\n/其他'], canWithOrder: false },
  { code: '6102', name: '苹果片', yuan: '7', originalYuan: '7', tags: ['小食'], cats: ['小食甜品\n/其他'], canWithOrder: false },
  { code: '6352', name: '阳光橙麦炫酷', yuan: '13', originalYuan: '13', tags: ['冷饮'], cats: ['饮品'], canWithOrder: false },
  { code: '6362', name: '100% 苹果汁(盒装)', yuan: '11.5', originalYuan: '11.5', tags: ['冷饮'], cats: ['饮品'], canWithOrder: false },
  { code: '507389', name: '浓缩咖啡', yuan: '15', originalYuan: '15', tags: ['麦咖啡™咖啡'], cats: ['麦咖啡™'], canWithOrder: false },
  { code: '507394', name: '牛奶', yuan: '19', originalYuan: '19', tags: ['其他'], cats: ['麦咖啡™'], canWithOrder: false },
  { code: '507409', name: '麦咖啡™奶铁', yuan: '13.9', originalYuan: '21', tags: ['限定特惠', '更奶更浓'], cats: ['麦咖啡™'], canWithOrder: false },
  { code: '507411', name: '麦咖啡™美式', yuan: '11.9', originalYuan: '19', tags: ['限定特惠'], cats: ['麦咖啡™'], canWithOrder: false },
  { code: '510479', name: '燕麦奶铁', yuan: '9.9', originalYuan: '23', tags: ['麦咖啡™咖啡'], cats: ['麦咖啡™'], canWithOrder: true },
  { code: '510488', name: '燕麦奶', yuan: '21', originalYuan: '21', tags: ['其他'], cats: ['麦咖啡™'], canWithOrder: false },
  { code: '511781', name: '培根安格斯厚牛堡', yuan: '34.5', originalYuan: '34.5', tags: ['单品', '100%安格斯牛肉'], cats: ['安格斯MAX\n厚牛堡'], canWithOrder: false },
  { code: '511782', name: '芝士安格斯厚牛堡', yuan: '31.5', originalYuan: '31.5', tags: ['单品', '100%安格斯牛肉'], cats: ['安格斯MAX\n厚牛堡'], canWithOrder: false },
  { code: '515280', name: '阳光柠檬红茶', yuan: '9.5', originalYuan: '9.5', tags: ['冷饮'], cats: ['饮品'], canWithOrder: false },
  { code: '515520', name: '怡泉+C', yuan: '11.5', originalYuan: '11.5', tags: ['冷饮'], cats: ['饮品'], canWithOrder: false },
  { code: '515837', name: '圆筒冰淇淋', yuan: '5', originalYuan: '5', tags: ['冰淇淋'], cats: ['小食甜品\n/其他'], canWithOrder: false },
  { code: '515946', name: '浓浓黑巧（冰/热）', yuan: '13.9', originalYuan: '21', tags: ['限定特惠'], cats: ['人气热卖', '麦咖啡™'], canWithOrder: false },
  { code: '515949', name: '浓浓黑巧雪冰', yuan: '23', originalYuan: '23', tags: ['其他'], cats: ['麦咖啡™'], canWithOrder: false },
  { code: '515955', name: '浓浓燕麦黑巧（冰/热）', yuan: '15.9', originalYuan: '23', tags: ['限定特惠'], cats: ['麦咖啡™'], canWithOrder: false },
  { code: '520445', name: '薄皮焦香V翅', yuan: '15.5', originalYuan: '15.5', tags: ['单品', '人气'], cats: ['炸鸡'], canWithOrder: false },
  { code: '520689', name: '鲜萃咖啡', yuan: '9.5', originalYuan: '9.5', tags: ['麦咖啡™咖啡', '鲜萃咖啡', '热饮'], cats: ['麦咖啡™', '饮品'], canWithOrder: false },
  { code: '521156', name: '那么大鸡排（椒盐风味）', yuan: '14', originalYuan: '14', tags: ['单品'], cats: ['炸鸡'], canWithOrder: false },
  { code: '521316', name: '高达吉士双牛堡', yuan: '22.5', originalYuan: '22.5', tags: ['单品', '100%纯牛肉', '人气'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: false },
  { code: '521741', name: '脆薯饼', yuan: '8', originalYuan: '8', tags: ['小食'], cats: ['小食甜品\n/其他'], canWithOrder: false },
  { code: '521750', name: '泷盐星星麦旋风', yuan: '16', originalYuan: '16', tags: ['冰淇淋', '素龙饼干'], cats: ['小食甜品\n/其他'], canWithOrder: false },
  { code: '521816', name: '酥酥多笋卷', yuan: '20.5', originalYuan: '20.5', tags: ['单品', '全新升级', '川香风味'], cats: ['鸡肉汉堡\n/卷'], canWithOrder: false },
  { code: '521817', name: '【美汁源】“多汁柠柠”', yuan: '12', originalYuan: '12', tags: ['上新', '清爽上新'], cats: ['饮品'], canWithOrder: false },
  { code: '521901', name: '月下相思扭扭薯', yuan: '15.5', originalYuan: '15.5', tags: ['上新', '口口酥脆', '薯香十足'], cats: ['小食甜品\n/其他'], canWithOrder: false },
  { code: '521917', name: '泷愿成真麦旋风——大米风味', yuan: '16', originalYuan: '16', tags: ['上新', '快乐旋开吃'], cats: ['小食甜品\n/其他'], canWithOrder: false },
  { code: '521950', name: '蓝莓爆爆珠麦旋风', yuan: '16', originalYuan: '16', tags: ['蓝莓', '上新'], cats: ['人气热卖', '小食甜品\n/其他'], canWithOrder: false },
  { code: '521951', name: '灰焰圆筒', yuan: '5', originalYuan: '5', tags: ['上新', '灰焰'], cats: ['小食甜品\n/其他'], canWithOrder: false },
  { code: '521952', name: '龙焰鸡腿堡', yuan: '24', originalYuan: '24', tags: ['上新', '韩式辣椒黄油风味'], cats: ['鸡肉汉堡\n/卷'], canWithOrder: false },
  { code: '521953', name: '龙焰芝士棒鸡腿堡', yuan: '27', originalYuan: '27', tags: ['上新', '浓郁奶香拉丝芝士'], cats: ['鸡肉汉堡\n/卷'], canWithOrder: false },
  { code: '521966', name: '韩式烟熏芝士风味酱', yuan: '3', originalYuan: '3', tags: ['蘸酱', '韩式风味', '浓郁芝香'], cats: ['蘸酱炸鸡', '炸鸡'], canWithOrder: false },
  { code: '521986', name: '马苏里拉拉丝芝士条', yuan: '15.5', originalYuan: '15.5', tags: ['上新', '趁热拉丝', '奶香醇厚'], cats: ['小食甜品\n/其他'], canWithOrder: false },
  { code: '9900005456', name: '麦辣鸡腿汉堡三件套', yuan: '33.5', originalYuan: '46.5', tags: ['套餐', '立省10.5元起'], cats: ['鸡肉汉堡\n/卷'], canWithOrder: false },
  { code: '9900016078', name: '蘸酱麦麦脆汁鸡', yuan: '11.9', originalYuan: '18', tags: ['蘸酱炸鸡', '韩式芝士风味酱上新'], cats: ['蘸酱炸鸡'], canWithOrder: false },
  { code: '9900016076', name: '“我就喜欢”鸡薯双全盒', yuan: '15.9', originalYuan: '29', tags: ['心形薯饼同款比心', '上新'], cats: ['人气热卖', '小食拼盘\n/多人餐'], canWithOrder: false },
  { code: '9900016077', name: '蘸酱炸鸡', yuan: '11.9', originalYuan: '17', tags: ['韩式芝士风味酱上新'], cats: ['人气热卖'], canWithOrder: false },
  { code: '9900016075', name: '龙焰芝士棒鸡腿堡三件套', yuan: '29.9', originalYuan: '51', tags: ['浓郁奶香拉丝芝士', '上新'], cats: ['人气热卖', '鸡肉汉堡\n/卷'], canWithOrder: false },
  { code: '9900016073', name: '龙焰鸡腿堡三件套', yuan: '26.9', originalYuan: '48', tags: ['韩式辣椒黄油风味', '上新'], cats: ['人气热卖', '鸡肉汉堡\n/卷'], canWithOrder: false },
  { code: '9900005460', name: '麦香鱼套餐', yuan: '33.5', originalYuan: '46.5', tags: ['套餐', '麦香鱼系列'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: false },
  { code: '9900005462', name: '板烧鸡腿堡三件套', yuan: '34.5', originalYuan: '47.5', tags: ['套餐', '新升级', '更多汁'], cats: ['鸡肉汉堡\n/卷'], canWithOrder: false },
  { code: '9900005464', name: '双层吉士汉堡套餐', yuan: '34', originalYuan: '47', tags: ['套餐', '100%纯牛肉'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: false },
  { code: '9900004236', name: '人气超值四件套随心选', yuan: '28', originalYuan: '57', tags: ['麦金卡'], cats: ['精选单人餐'], canWithOrder: true },
  { code: '9900005466', name: '巨无霸三件套', yuan: '37.5', originalYuan: '50.5', tags: ['套餐', '100%纯牛肉'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: false },
  { code: '9900005449', name: '吉士汉堡包套餐', yuan: '26', originalYuan: '39', tags: ['套餐', '100%纯牛肉'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: false },
  { code: '9900015008', name: '酥酥多笋卷三件套', yuan: '31.5', originalYuan: '44.5', tags: ['套餐', '全新升级', '川香风味'], cats: ['鸡肉汉堡\n/卷'], canWithOrder: false },
  { code: '9900010110', name: '鱼牛汉堡四件套随心选', yuan: '32', originalYuan: '59', tags: ['麦金卡'], cats: ['精选单人餐'], canWithOrder: true },
  { code: '9900005451', name: '麦辣鸡翅4块套餐', yuan: '36.5', originalYuan: '49.5', tags: ['套餐', '立省10.5元起'], cats: ['炸鸡'], canWithOrder: false },
  { code: '9900005453', name: '麦香鸡套餐', yuan: '28', originalYuan: '41', tags: ['套餐', '立省10.5元起'], cats: ['鸡肉汉堡\n/卷'], canWithOrder: false },
  { code: '9900008746', name: '鸡肉堡单品精选', yuan: '23.5', originalYuan: '23.5', tags: ['单品', '人气'], cats: ['鸡肉汉堡\n/卷'], canWithOrder: false },
  { code: '9900008745', name: '新地', yuan: '12', originalYuan: '12', tags: ['冰淇淋'], cats: ['小食甜品\n/其他'], canWithOrder: false },
  { code: '9900008747', name: '牛肉堡单品精选', yuan: '13.5', originalYuan: '13.5', tags: ['单品', '100%纯牛肉'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: false },
  { code: '9900016096', name: '蘸酱韩式甜辣酱鸡块', yuan: '11.9', originalYuan: '18', tags: ['蘸酱炸鸡', '韩式芝士风味酱上新'], cats: ['蘸酱炸鸡'], canWithOrder: false },
  { code: '9900008751', name: '可乐', yuan: '9.5', originalYuan: '9.5', tags: ['冷饮'], cats: ['饮品'], canWithOrder: false },
  { code: '9900006332', name: '薄皮V翅双拼十翅', yuan: '49.9', originalYuan: '74.5', tags: ['小食拼盘', '超值'], cats: ['小食拼盘\n/多人餐'], canWithOrder: false },
  { code: '9900008752', name: '派', yuan: '8.5', originalYuan: '8.5', tags: ['派', '第二份优惠'], cats: ['小食甜品\n/其他'], canWithOrder: false },
  { code: '9900008754', name: '经典麦旋风', yuan: '15', originalYuan: '15', tags: ['冰淇淋'], cats: ['小食甜品\n/其他'], canWithOrder: false },
  { code: '9900005468', name: '培根蔬萃双层牛堡三件套', yuan: '35.5', originalYuan: '48.5', tags: ['套餐', '100%纯牛肉'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: false },
  { code: '9900006957', name: '安格斯厚牛堡四件套随心选', yuan: '37', originalYuan: '66', tags: ['麦金卡'], cats: ['精选单人餐'], canWithOrder: true },
  { code: '9900016082', name: '心形薯饼5块', yuan: '15', originalYuan: '15', tags: ['上新', '口口酥脆', '含一份蘸酱'], cats: ['小食甜品\n/其他'], canWithOrder: false },
  { code: '9900005413', name: '双层深海鳕鱼堡三件套', yuan: '36', originalYuan: '49', tags: ['套餐', '麦香鱼系列'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: false },
  { code: '9900016309', name: '龙焰鸡腿堡四件套', yuan: '29', originalYuan: '57', tags: ['麦金卡'], cats: ['鸡肉汉堡\n/卷'], canWithOrder: true },
  { code: '9900015730', name: 'BFF四宫格小食盘', yuan: '40.3', originalYuan: '53.5', tags: ['小食拼盘', '随心拼'], cats: ['小食拼盘\n/多人餐'], canWithOrder: false },
  { code: '9900015852', name: '举杯邀月柚桂茶', yuan: '13', originalYuan: '13', tags: ['上新', '第二份半价', '馥郁香气'], cats: ['饮品'], canWithOrder: false },
  { code: '9900016310', name: '龙焰芝士棒鸡腿堡四件套', yuan: '32', originalYuan: '57', tags: ['麦金卡'], cats: ['鸡肉汉堡\n/卷'], canWithOrder: true },
  { code: '9900004835', name: '麦乐鸡套餐', yuan: '25', originalYuan: '38', tags: ['套餐', '立省10.5元起'], cats: ['炸鸡'], canWithOrder: false },
  { code: '9900003586', name: '双层深海鳕鱼堡', yuan: '25', originalYuan: '25', tags: ['单品', '麦香鱼系列'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: false },
  { code: '9900000890', name: '板烧鸡腿堡四件套', yuan: '28', originalYuan: '57', tags: ['麦金卡'], cats: ['鸡肉汉堡\n/卷'], canWithOrder: true },
  { code: '9900015729', name: '蘸酱BFF四宫格小食盘', yuan: '43.3', originalYuan: '56.5', tags: ['蘸酱炸鸡', '蘸酱炸鸡新吃法'], cats: ['蘸酱炸鸡'], canWithOrder: false },
  { code: '9900013304', name: '人气经典随心配', yuan: '14.9', originalYuan: '14.9', tags: ['超值百种组合随心配'], cats: ['随心配\n1+1'], canWithOrder: false },
  { code: '9900015726', name: '韩式甜辣酱鸡块8块', yuan: '19.9', originalYuan: '30', tags: ['上新', '韩式风味'], cats: ['小食拼盘\n/多人餐'], canWithOrder: false },
  { code: '9900011126', name: '酥脆无双套餐', yuan: '20.5', originalYuan: '20.5', tags: [], cats: ['500\n大卡套餐'], canWithOrder: false },
  { code: '9900015602', name: '大堡口福三件套', yuan: '22.9', originalYuan: '47.5', tags: ['大口吃肉好快乐'], cats: ['大堡口福\n单人餐'], canWithOrder: false },
  { code: '9900011128', name: '“堡”你欢乐套餐', yuan: '28', originalYuan: '42', tags: ['粉丝之选'], cats: ['500\n大卡套餐'], canWithOrder: false },
  { code: '9900011121', name: '“苹”水相“鱼”套餐', yuan: '36', originalYuan: '53', tags: ['粉丝之选'], cats: ['500\n大卡套餐'], canWithOrder: false },
  { code: '9900015568', name: '精选超值随心配', yuan: '13.9', originalYuan: '13.9', tags: ['超值百种组合随心配'], cats: ['随心配\n1+1'], canWithOrder: false },
  { code: '9900011123', name: '“辣”么快乐套餐', yuan: '24', originalYuan: '36', tags: [], cats: ['500\n大卡套餐'], canWithOrder: false },
  { code: '9900000888', name: '巨无霸四件套', yuan: '32', originalYuan: '59', tags: ['麦金卡'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: true },
  { code: '9900000886', name: '不素之霸双层牛堡四件套', yuan: '32', originalYuan: '59', tags: ['麦金卡'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: true },
  { code: '9900000884', name: '酥酥多笋卷四件套', yuan: '28', originalYuan: '55', tags: ['麦金卡'], cats: ['鸡肉汉堡\n/卷'], canWithOrder: true },
  { code: '9900000885', name: '培根蔬萃双层牛堡四件套', yuan: '32', originalYuan: '59', tags: ['麦金卡'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: true },
  { code: '9900000882', name: '芝士安格斯厚牛堡四件套', yuan: '37', originalYuan: '66', tags: ['麦金卡'], cats: ['安格斯MAX\n厚牛堡'], canWithOrder: true },
  { code: '9900005411', name: '不素之霸双层牛堡三件套', yuan: '37.5', originalYuan: '50.5', tags: ['套餐', '100%纯牛肉'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: false },
  { code: '9900000881', name: '培根安格斯厚牛堡四件套', yuan: '37', originalYuan: '66', tags: ['麦金卡'], cats: ['安格斯MAX\n厚牛堡'], canWithOrder: true },
  { code: '9900004066', name: '堡堡随心拼（7件任选）', yuan: '73', originalYuan: '103', tags: ['小食拼盘', '万种组合'], cats: ['小食拼盘\n/多人餐'], canWithOrder: false },
  { code: '9900004064', name: '精选单人餐三件套', yuan: '34.5', originalYuan: '46.5', tags: ['爆款', '经典精选'], cats: ['人气热卖', '精选单人餐'], canWithOrder: false },
  { code: '9900016058', name: '鱼排堡开心乐园餐', yuan: '24', originalYuan: '24', tags: ['开心乐园餐', '童年童款'], cats: ['开心乐园'], canWithOrder: false },
  { code: '9900016056', name: '麦乐鸡开心乐园餐', yuan: '25', originalYuan: '25', tags: ['开心乐园餐', '童年童款'], cats: ['开心乐园'], canWithOrder: false },
  { code: '9900016057', name: '汉堡开心乐园餐', yuan: '23.5', originalYuan: '23.5', tags: ['开心乐园餐', '童年童款'], cats: ['开心乐园'], canWithOrder: false },
  { code: '9900016055', name: '开心亲子双人餐', yuan: '59.5', originalYuan: '59.5', tags: ['开心亲子餐', '童年童款'], cats: ['开心乐园'], canWithOrder: false },
  { code: '9900009242', name: '“苹板”支撑Pro套餐', yuan: '39.5', originalYuan: '53.5', tags: [], cats: ['500\n大卡套餐'], canWithOrder: false },
  { code: '9900009245', name: '牛气满满套餐', yuan: '34.5', originalYuan: '47.5', tags: [], cats: ['500\n大卡套餐'], canWithOrder: false },
  { code: '9900000893', name: '双层深海鳕鱼堡四件套', yuan: '32', originalYuan: '59', tags: ['麦金卡'], cats: ['巨无霸\n牛鱼肉堡'], canWithOrder: true },
  { code: '9900005321', name: 'BFF四宫格小食盘双人餐', yuan: '62.9', originalYuan: '122.5', tags: ['麦金卡'], cats: ['小食拼盘\n/多人餐'], canWithOrder: true },
  { code: '9900000891', name: '麦辣鸡腿堡四件套', yuan: '28', originalYuan: '57', tags: ['麦金卡'], cats: ['鸡肉汉堡\n/卷'], canWithOrder: true },
  { code: '9900005428', name: '培根安格斯厚牛堡三件套', yuan: '45.5', originalYuan: '58.5', tags: ['套餐', '100%安格斯牛肉'], cats: ['安格斯MAX\n厚牛堡'], canWithOrder: false },
  { code: '9900005430', name: '芝士安格斯厚牛堡三件套', yuan: '42.5', originalYuan: '55.5', tags: ['套餐', '100%安格斯牛肉'], cats: ['安格斯MAX\n厚牛堡'], canWithOrder: false },
  { code: '9900005432', name: '麦麦脆汁鸡1块', yuan: '15', originalYuan: '15', tags: ['单品'], cats: ['炸鸡'], canWithOrder: false },
];

const SAMPLE_CATEGORY_ROWS: readonly MenuCategory[] = [
  { name: '人气热卖', codes: ['9900016076', '9900016075', '9900016073', '9900016077', '9900004064', '521950', '515946'] },
  { name: '精选单人餐', codes: ['9900004064', '9900004236', '9900010110', '9900006957'] },
  { name: '鸡肉汉堡\n/卷', codes: ['9900016075', '9900016073', '521953', '521952', '9900016310', '9900016309', '9900000891', '9900000890', '9900000884', '9900005462', '9900005456', '9900005453', '9900015008', '1440', '1406', '1450', '521816', '9900008746'] },
  { name: '小食拼盘\n/多人餐', codes: ['9900016076', '9900015726', '9900006332', '9900015730', '9900004066', '9900005321'] },
  { name: '蘸酱炸鸡', codes: ['9900016078', '9900016096', '9900015729', '521966'] },
  { name: '随心配\n1+1', codes: ['9900013304', '9900015568'] },
  { name: '大堡口福\n单人餐', codes: ['9900015602'] },
  { name: '巨无霸\n牛鱼肉堡', codes: ['9900000888', '9900000886', '9900000885', '9900000893', '9900005411', '9900005466', '9900005468', '9900005413', '9900005460', '9900005464', '9900005449', '1100', '9900003586', '1600', '4648', '1106', '1120', '521316', '9900008747'] },
  { name: '安格斯MAX\n厚牛堡', codes: ['9900000881', '9900000882', '9900005428', '9900005430', '511781', '511782'] },
  { name: '炸鸡', codes: ['521966', '9900005451', '9900004835', '1700', '520445', '1401', '521156', '9900005432'] },
  { name: '小食甜品\n/其他', codes: ['521986', '9900016082', '521950', '521951', '521901', '521917', '521741', '4810', '4437', '6102', '521750', '9900008754', '9900008745', '515837', '9900008752'] },
  { name: '开心乐园', codes: ['9900016057', '9900016058', '9900016056', '9900016055'] },
  { name: '麦咖啡™', codes: ['515946', '515955', '507411', '507409', '510479', '520689', '507389', '515949', '507394', '510488'] },
  { name: '500\n大卡套餐', codes: ['9900011128', '9900011121', '9900011126', '9900011123', '9900009245', '9900009242'] },
  { name: '饮品', codes: ['9900015852', '521817', '9900008751', '3010', '515520', '2430', '515280', '6352', '3755', '6362', '3757', '520689', '3505'] },
];

function toMenuItem(row: SampleItemRow): MenuItem {
  return {
    code: row.code,
    name: row.name,
    priceCents: yuanToCents(row.yuan),
    originalPriceCents: yuanToCents(row.originalYuan),
    tags: row.tags,
    categories: row.cats,
    canWithOrder: row.canWithOrder,
  };
}

const SAMPLE_ITEMS: readonly MenuItem[] = SAMPLE_ITEM_ROWS.map(toMenuItem);

export const SAMPLE_MENU: Menu = {
  storeCode: SAMPLE_DEFAULT_STORE_CODE,
  categories: SAMPLE_CATEGORY_ROWS,
  items: SAMPLE_ITEMS,
};

/** 只有拿到价格的那部分才是可下单的，避免把「价格未知」的商品卖给用户 */
export const SAMPLE_ORDERABLE_ITEMS: readonly MenuItem[] = SAMPLE_ITEMS.filter(hasPrice);

// ─────────────────────────────────────────────────────────────
// 餐品详情（含「不要酸黄瓜」所需的真实特制 code）
// ─────────────────────────────────────────────────────────────

/** 巨无霸的详情原文，取真实 `query-meal-detail` 响应 */
export const SAMPLE_MEAL_DETAIL_RAW: Record<string, unknown> = {
    "code": "1100",
    "name": "巨无霸",
    "rounds": [],
    "image": "https://menu-img.mcd.cn/pcm/prod/menu/20250611/product/MS_1100_600_1749175370846.png",
    "modification": {
      "items": [
        {
          "maxValues": 5,
          "minValues": 0,
          "values": [
            {
              "code": "100116",
              "price": 0,
              "name": "巨无霸酱",
              "maxQuantity": 1,
              "minQuantity": 0,
              "selectedQuantity": 1,
              "selectedKey": "0-1",
              "unselectedKey": "0-0"
            },
            {
              "code": "100141",
              "price": 0,
              "name": "吉士",
              "maxQuantity": 1,
              "minQuantity": 0,
              "selectedQuantity": 1,
              "selectedKey": "0-1",
              "unselectedKey": "0-0"
            },
            {
              "code": "100168",
              "price": 0,
              "name": "生菜",
              "maxQuantity": 1,
              "minQuantity": 0,
              "selectedQuantity": 1,
              "selectedKey": "0-1",
              "unselectedKey": "0-0"
            },
            {
              "code": "100202",
              "price": 0,
              "name": "酸黄瓜",
              "maxQuantity": 1,
              "minQuantity": 0,
              "selectedQuantity": 1,
              "selectedKey": "0-1",
              "unselectedKey": "0-0"
            },
            {
              "code": "100212",
              "price": 0,
              "name": "洋葱粒",
              "maxQuantity": 1,
              "minQuantity": 0,
              "selectedQuantity": 1,
              "selectedKey": "0-1",
              "unselectedKey": "0-0"
            }
          ]
        }
      ]
    },
    "supportModify": true
  };

export const SAMPLE_MEAL_DETAIL_CODE = String(SAMPLE_MEAL_DETAIL_RAW.code ?? '');

/** 注意要包一层信封 —— normalize 的 readEnvelope 期待完整的 { success, data } 结构 */
export const SAMPLE_MEAL_DETAIL = parseMealDetail({
  success: true,
  code: 200,
  message: '离线快照',
  data: SAMPLE_MEAL_DETAIL_RAW,
});

// ─────────────────────────────────────────────────────────────
// 取餐方式（实测到店场景的两项）
// ─────────────────────────────────────────────────────────────

export const SAMPLE_TAKE_WAYS = [
  { code: 'eat-in', title: '堂食', subtitle: '店内用餐' },
  { code: 'take-in-store', title: '外带', subtitle: '店内自提' },
] as const;

/** 演示模式下产出的支付链接，明确标注不是真实地址 */
export const SAMPLE_PAY_URL = 'https://example.invalid/mock-pay/demo-order-0001';

/** 演示模式下的示例订单号 */
export const SAMPLE_ORDER_ID = 'DEMO-ORDER-0001';

/** 占位：营养数据在离线演示下不加载 */
export const SAMPLE_NUTRITION: ParseNutritionResult = { records: [], skipped: 0, declaredTotal: 0 };
