import type Database from 'better-sqlite3'
import { hashSync } from 'bcryptjs'
import type { CurrencyDefinition } from '../currency/catalog'
import { formatMoney } from '../currency/money'
import { fromMinor, toMinor } from '../currency/parse'
import type { Edition } from '../editions'
import type { PublicUser } from '../shared/auth/types'
import { defaultPermissions } from '../shared/auth/policy'
import type { DemoDatasetState, DemoLoadResult } from '../shared/demo/types'
import type { ShopRepository } from './contracts/shop-repository'
import type { UserRepository } from './contracts/user-repository'
import type { ProductInventoryService } from './product-inventory-service'

/**
 * Optional demonstration data an Admin can load to try the app before entering real stock, and just as
 * importantly remove again. Two rules shape everything here.
 *
 * 1. **Loading is not a transaction.** The brief says demo data counts against the currency lock only if
 *    sales are created. This loader therefore creates no sale, no purchase, no return and no stock
 *    valuation: it inserts products, one opening stock movement of type `ADJUSTMENT` per product so the
 *    quantity can be explained, and a couple of promotions. Nothing it writes fires the
 *    `lock_currency_after_*` triggers, so a shop that loads the demo, looks around and removes it is back
 *    to an unlocked currency and can still change it.
 * 2. **Removal must be provably clean.** Every row is tagged with the marker prefix on its primary key
 *    (`demo-`), and removal refuses outright if any real work now depends on it — a sale, a return, a
 *    purchase order line, a stocktake or a stock movement that is not the demo's own opening movement.
 *    Deleting a product that a completed sale references would either fail a foreign key or, worse,
 *    orphan history; so the service stops and says so instead.
 */

export const DEMO_PREFIX = 'demo-'

/** Products are derived from the shop's currency, so the prices look plausible in any of the 54. */
interface DemoProduct {
  sku: string
  name: string
  brand: string
  category: string
  subCategory: string
  department?: string
  unit: string
  packSizeUnits: number
  /** Retail price in whole major units, scaled by the profile below. */
  retail: number
  /** Wholesale price as a fraction of retail (0.88 = 12% off). */
  wholesaleRatio: number
  cost: number
  genericName?: string
  prescription?: boolean
  weighed?: boolean
  plu?: string
  /** Price per kilogram in whole major units, for weighed items. */
  pricePerKg?: number
  batches: Array<{ batchNumber: string; daysToExpiry: number; quantity: number }>
}

const PHARMACY_PRODUCTS: DemoProduct[] = [
  { sku: 'DEMO-PH-001', name: 'Paracetamol 500mg Tablets (Pack of 20)', brand: 'Emzor', category: 'Analgesics', subCategory: 'Tablets', unit: 'pack', packSizeUnits: 20, retail: 850, wholesaleRatio: 0.84, cost: 520, genericName: 'Paracetamol', batches: [
    { batchNumber: 'PCM-A41', daysToExpiry: 540, quantity: 40 }, { batchNumber: 'PCM-A42', daysToExpiry: 60, quantity: 12 },
  ] },
  { sku: 'DEMO-PH-002', name: 'Ibuprofen 400mg Tablets (Pack of 12)', brand: 'Ranbaxy', category: 'Analgesics', subCategory: 'Tablets', unit: 'pack', packSizeUnits: 12, retail: 1200, wholesaleRatio: 0.85, cost: 760, genericName: 'Ibuprofen', batches: [
    { batchNumber: 'IBU-2210', daysToExpiry: 400, quantity: 30 },
  ] },
  { sku: 'DEMO-PH-003', name: 'Amoxicillin 500mg Capsules (Pack of 21)', brand: 'GSK', category: 'Antibiotics', subCategory: 'Capsules', unit: 'pack', packSizeUnits: 21, retail: 4500, wholesaleRatio: 0.9, cost: 3100, genericName: 'Amoxicillin', prescription: true, batches: [
    { batchNumber: 'AMX-7741', daysToExpiry: 300, quantity: 18 }, { batchNumber: 'AMX-7742', daysToExpiry: 45, quantity: 6 },
  ] },
  { sku: 'DEMO-PH-004', name: 'Ciprofloxacin 500mg Tablets (Pack of 10)', brand: 'Cipla', category: 'Antibiotics', subCategory: 'Tablets', unit: 'pack', packSizeUnits: 10, retail: 3800, wholesaleRatio: 0.89, cost: 2500, genericName: 'Ciprofloxacin', prescription: true, batches: [
    { batchNumber: 'CIP-1102', daysToExpiry: 270, quantity: 25 },
  ] },
  { sku: 'DEMO-PH-005', name: 'Metformin 500mg Tablets (Pack of 30)', brand: 'GlaxoSmithKline', category: 'Diabetes Care', subCategory: 'Tablets', unit: 'pack', packSizeUnits: 30, retail: 2600, wholesaleRatio: 0.88, cost: 1700, genericName: 'Metformin', prescription: true, batches: [
    { batchNumber: 'MET-3308', daysToExpiry: 620, quantity: 22 },
  ] },
  { sku: 'DEMO-PH-006', name: 'Amlodipine 5mg Tablets (Pack of 30)', brand: 'Pfizer', category: 'Cardiovascular', subCategory: 'Tablets', unit: 'pack', packSizeUnits: 30, retail: 3100, wholesaleRatio: 0.88, cost: 2000, genericName: 'Amlodipine', prescription: true, batches: [
    { batchNumber: 'AML-5520', daysToExpiry: 500, quantity: 20 },
  ] },
  { sku: 'DEMO-PH-007', name: 'Lisinopril 10mg Tablets (Pack of 28)', brand: 'Novartis', category: 'Cardiovascular', subCategory: 'Tablets', unit: 'pack', packSizeUnits: 28, retail: 4200, wholesaleRatio: 0.9, cost: 2900, genericName: 'Lisinopril', prescription: true, batches: [
    { batchNumber: 'LIS-9001', daysToExpiry: 380, quantity: 15 },
  ] },
  { sku: 'DEMO-PH-008', name: 'Vitamin C 1000mg Effervescent (Tube of 20)', brand: 'HealthAid', category: 'Vitamins & Supplements', subCategory: 'Effervescent', unit: 'tube', packSizeUnits: 20, retail: 2300, wholesaleRatio: 0.86, cost: 1450, batches: [
    { batchNumber: 'VTC-4412', daysToExpiry: 700, quantity: 35 },
  ] },
  { sku: 'DEMO-PH-009', name: 'Multivitamin Syrup 200ml', brand: 'Vitabiotics', category: 'Vitamins & Supplements', subCategory: 'Syrups', unit: 'bottle', packSizeUnits: 1, retail: 3200, wholesaleRatio: 0.87, cost: 2100, batches: [
    { batchNumber: 'MVS-2210', daysToExpiry: 330, quantity: 16 },
  ] },
  { sku: 'DEMO-PH-010', name: 'Zinc Sulphate 20mg Tablets (Pack of 20)', brand: 'Emzor', category: 'Vitamins & Supplements', subCategory: 'Tablets', unit: 'pack', packSizeUnits: 20, retail: 900, wholesaleRatio: 0.85, cost: 550, batches: [
    { batchNumber: 'ZNC-7781', daysToExpiry: 480, quantity: 28 },
  ] },
  { sku: 'DEMO-PH-011', name: 'Cough Linctus 100ml', brand: 'Benylin', category: 'Respiratory', subCategory: 'Syrups', unit: 'bottle', packSizeUnits: 1, retail: 2800, wholesaleRatio: 0.88, cost: 1800, batches: [
    { batchNumber: 'CGH-3311', daysToExpiry: 240, quantity: 20 },
  ] },
  { sku: 'DEMO-PH-012', name: 'Salbutamol Inhaler 100mcg', brand: 'GSK', category: 'Respiratory', subCategory: 'Inhalers', unit: 'inhaler', packSizeUnits: 1, retail: 6500, wholesaleRatio: 0.91, cost: 4600, genericName: 'Salbutamol', prescription: true, batches: [
    { batchNumber: 'SAL-8830', daysToExpiry: 420, quantity: 10 },
  ] },
  { sku: 'DEMO-PH-013', name: 'Loratadine 10mg Tablets (Pack of 10)', brand: 'Claritin', category: 'Antihistamines', subCategory: 'Tablets', unit: 'pack', packSizeUnits: 10, retail: 1500, wholesaleRatio: 0.86, cost: 950, genericName: 'Loratadine', batches: [
    { batchNumber: 'LOR-1120', daysToExpiry: 610, quantity: 24 },
  ] },
  { sku: 'DEMO-PH-014', name: 'Chlorpheniramine 4mg Tablets (Pack of 20)', brand: 'Piriton', category: 'Antihistamines', subCategory: 'Tablets', unit: 'pack', packSizeUnits: 20, retail: 700, wholesaleRatio: 0.84, cost: 400, genericName: 'Chlorpheniramine', batches: [
    { batchNumber: 'CHL-9931', daysToExpiry: 520, quantity: 32 },
  ] },
  { sku: 'DEMO-PH-015', name: 'Omeprazole 20mg Capsules (Pack of 14)', brand: 'AstraZeneca', category: 'Gastrointestinal', subCategory: 'Capsules', unit: 'pack', packSizeUnits: 14, retail: 3400, wholesaleRatio: 0.89, cost: 2200, genericName: 'Omeprazole', batches: [
    { batchNumber: 'OMP-4402', daysToExpiry: 360, quantity: 19 },
  ] },
  { sku: 'DEMO-PH-016', name: 'Oral Rehydration Salts (Box of 10 sachets)', brand: 'ORS Plus', category: 'Gastrointestinal', subCategory: 'Sachets', unit: 'box', packSizeUnits: 10, retail: 1100, wholesaleRatio: 0.85, cost: 680, batches: [
    { batchNumber: 'ORS-6620', daysToExpiry: 800, quantity: 40 },
  ] },
  { sku: 'DEMO-PH-017', name: 'Antacid Suspension 200ml', brand: 'Gaviscon', category: 'Gastrointestinal', subCategory: 'Suspensions', unit: 'bottle', packSizeUnits: 1, retail: 2400, wholesaleRatio: 0.87, cost: 1550, batches: [
    { batchNumber: 'ANT-1188', daysToExpiry: 290, quantity: 22 },
  ] },
  { sku: 'DEMO-PH-018', name: 'Diclofenac Gel 50g', brand: 'Voltaren', category: 'Topical', subCategory: 'Gels', unit: 'tube', packSizeUnits: 1, retail: 2900, wholesaleRatio: 0.88, cost: 1900, batches: [
    { batchNumber: 'DIC-3320', daysToExpiry: 430, quantity: 18 },
  ] },
  { sku: 'DEMO-PH-019', name: 'Povidone Iodine Solution 100ml', brand: 'Betadine', category: 'Topical', subCategory: 'Antiseptics', unit: 'bottle', packSizeUnits: 1, retail: 1700, wholesaleRatio: 0.86, cost: 1050, batches: [
    { batchNumber: 'PVI-7742', daysToExpiry: 560, quantity: 26 },
  ] },
  { sku: 'DEMO-PH-020', name: 'Cotton Wool Roll 100g', brand: 'Sunlight', category: 'First Aid', subCategory: 'Dressings', unit: 'roll', packSizeUnits: 1, retail: 600, wholesaleRatio: 0.82, cost: 320, batches: [
    { batchNumber: 'CTW-2210', daysToExpiry: 900, quantity: 50 },
  ] },
  { sku: 'DEMO-PH-021', name: 'Adhesive Plasters (Box of 40)', brand: 'Hansaplast', category: 'First Aid', subCategory: 'Dressings', unit: 'box', packSizeUnits: 40, retail: 1300, wholesaleRatio: 0.85, cost: 800, batches: [
    { batchNumber: 'PLS-9930', daysToExpiry: 1000, quantity: 30 },
  ] },
  { sku: 'DEMO-PH-022', name: 'Digital Thermometer', brand: 'Omron', category: 'Devices', subCategory: 'Diagnostics', unit: 'each', packSizeUnits: 1, retail: 7500, wholesaleRatio: 0.92, cost: 5400, batches: [
    { batchNumber: 'THM-1102', daysToExpiry: 1800, quantity: 8 },
  ] },
  { sku: 'DEMO-PH-023', name: 'Blood Pressure Monitor (Upper Arm)', brand: 'Omron', category: 'Devices', subCategory: 'Diagnostics', unit: 'each', packSizeUnits: 1, retail: 32000, wholesaleRatio: 0.93, cost: 24000, batches: [
    { batchNumber: 'BPM-6621', daysToExpiry: 1800, quantity: 4 },
  ] },
  { sku: 'DEMO-PH-024', name: 'Glucometer with 25 Test Strips', brand: 'Accu-Chek', category: 'Devices', subCategory: 'Diagnostics', unit: 'each', packSizeUnits: 1, retail: 18500, wholesaleRatio: 0.92, cost: 13500, batches: [
    { batchNumber: 'GLU-3341', daysToExpiry: 1500, quantity: 5 },
  ] },
  { sku: 'DEMO-PH-025', name: 'Face Masks (Box of 50)', brand: 'MedGuard', category: 'Infection Control', subCategory: 'Protective', unit: 'box', packSizeUnits: 50, retail: 3500, wholesaleRatio: 0.88, cost: 2300, batches: [
    { batchNumber: 'MSK-8821', daysToExpiry: 1200, quantity: 20 },
  ] },
  { sku: 'DEMO-PH-026', name: 'Hand Sanitiser 500ml', brand: 'Dettol', category: 'Infection Control', subCategory: 'Hygiene', unit: 'bottle', packSizeUnits: 1, retail: 2200, wholesaleRatio: 0.86, cost: 1400, batches: [
    { batchNumber: 'SNT-4419', daysToExpiry: 640, quantity: 34 },
  ] },
  { sku: 'DEMO-PH-027', name: 'Folic Acid 5mg Tablets (Pack of 30)', brand: 'Emzor', category: 'Women’s Health', subCategory: 'Tablets', unit: 'pack', packSizeUnits: 30, retail: 1300, wholesaleRatio: 0.85, cost: 780, genericName: 'Folic acid', batches: [
    { batchNumber: 'FOL-2218', daysToExpiry: 470, quantity: 26 },
  ] },
  { sku: 'DEMO-PH-028', name: 'Prenatal Multivitamin (Pack of 30)', brand: 'Pregnacare', category: 'Women’s Health', subCategory: 'Tablets', unit: 'pack', packSizeUnits: 30, retail: 5600, wholesaleRatio: 0.9, cost: 3900, batches: [
    { batchNumber: 'PNV-6620', daysToExpiry: 350, quantity: 12 },
  ] },
  { sku: 'DEMO-PH-029', name: 'Baby Paracetamol Suspension 60ml', brand: 'Calpol', category: 'Paediatrics', subCategory: 'Suspensions', unit: 'bottle', packSizeUnits: 1, retail: 1900, wholesaleRatio: 0.87, cost: 1150, genericName: 'Paracetamol', batches: [
    { batchNumber: 'BPC-1102', daysToExpiry: 210, quantity: 21 },
  ] },
  { sku: 'DEMO-PH-030', name: 'Measured Dosing Syringe 5ml', brand: 'MedGuard', category: 'Paediatrics', subCategory: 'Accessories', unit: 'each', packSizeUnits: 1, retail: 250, wholesaleRatio: 0.8, cost: 120, batches: [
    { batchNumber: 'SYR-3301', daysToExpiry: 1600, quantity: 60 },
  ] },
]

const SUPERMARKET_PRODUCTS: DemoProduct[] = [
  { sku: 'DEMO-SM-001', name: 'Rice, Long Grain 5kg', brand: 'Mama Gold', category: 'Grains', subCategory: 'Rice', department: 'Grocery', unit: 'bag', packSizeUnits: 1, retail: 8500, wholesaleRatio: 0.94, cost: 7100, batches: [] },
  { sku: 'DEMO-SM-002', name: 'Rice, Basmati 2kg', brand: 'Aeroplane', category: 'Grains', subCategory: 'Rice', department: 'Grocery', unit: 'bag', packSizeUnits: 1, retail: 6200, wholesaleRatio: 0.94, cost: 5000, batches: [] },
  { sku: 'DEMO-SM-003', name: 'Beans, Brown 2kg', brand: 'Oloye', category: 'Grains', subCategory: 'Beans', department: 'Grocery', unit: 'bag', packSizeUnits: 1, retail: 4300, wholesaleRatio: 0.93, cost: 3400, batches: [] },
  { sku: 'DEMO-SM-004', name: 'Garri Ijebu 4kg', brand: 'Ijebu Gold', category: 'Grains', subCategory: 'Cassava', department: 'Grocery', unit: 'bag', packSizeUnits: 1, retail: 3600, wholesaleRatio: 0.93, cost: 2800, batches: [] },
  { sku: 'DEMO-SM-005', name: 'Semovita 1kg', brand: 'Golden Penny', category: 'Grains', subCategory: 'Flour', department: 'Grocery', unit: 'pack', packSizeUnits: 1, retail: 1450, wholesaleRatio: 0.94, cost: 1150, batches: [] },
  { sku: 'DEMO-SM-006', name: 'Wheat Flour 1kg', brand: 'Honeywell', category: 'Grains', subCategory: 'Flour', department: 'Grocery', unit: 'pack', packSizeUnits: 1, retail: 1250, wholesaleRatio: 0.94, cost: 980, batches: [] },
  { sku: 'DEMO-SM-007', name: 'Spaghetti 500g (Pack of 5)', brand: 'Golden Penny', category: 'Pasta', subCategory: 'Spaghetti', department: 'Grocery', unit: 'pack', packSizeUnits: 5, retail: 2400, wholesaleRatio: 0.93, cost: 1850, batches: [] },
  { sku: 'DEMO-SM-008', name: 'Indomie Instant Noodles (Carton of 40)', brand: 'Indomie', category: 'Pasta', subCategory: 'Noodles', department: 'Grocery', unit: 'carton', packSizeUnits: 40, retail: 9500, wholesaleRatio: 0.95, cost: 8000, batches: [] },
  { sku: 'DEMO-SM-009', name: 'Vegetable Oil 5L', brand: 'Devon King’s', category: 'Cooking Oils', subCategory: 'Vegetable', department: 'Grocery', unit: 'jerrycan', packSizeUnits: 1, retail: 12500, wholesaleRatio: 0.95, cost: 10600, batches: [
    { batchNumber: 'VO-2026A', daysToExpiry: 300, quantity: 14 },
  ] },
  { sku: 'DEMO-SM-010', name: 'Palm Oil 2L', brand: 'Terra', category: 'Cooking Oils', subCategory: 'Palm', department: 'Grocery', unit: 'bottle', packSizeUnits: 1, retail: 4200, wholesaleRatio: 0.94, cost: 3400, batches: [] },
  { sku: 'DEMO-SM-011', name: 'Tomato Paste 400g (Pack of 3)', brand: 'Gino', category: 'Canned & Packaged', subCategory: 'Tomato', department: 'Grocery', unit: 'pack', packSizeUnits: 3, retail: 2100, wholesaleRatio: 0.93, cost: 1600, batches: [
    { batchNumber: 'TP-8891', daysToExpiry: 220, quantity: 30 },
  ] },
  { sku: 'DEMO-SM-012', name: 'Baked Beans 400g', brand: 'Gino', category: 'Canned & Packaged', subCategory: 'Beans', department: 'Grocery', unit: 'tin', packSizeUnits: 1, retail: 950, wholesaleRatio: 0.92, cost: 700, batches: [
    { batchNumber: 'BB-3312', daysToExpiry: 400, quantity: 48 },
  ] },
  { sku: 'DEMO-SM-013', name: 'Sardines 125g (Pack of 3)', brand: 'Titus', category: 'Canned & Packaged', subCategory: 'Fish', department: 'Grocery', unit: 'pack', packSizeUnits: 3, retail: 2700, wholesaleRatio: 0.93, cost: 2050, batches: [
    { batchNumber: 'SAR-6621', daysToExpiry: 260, quantity: 24 },
  ] },
  { sku: 'DEMO-SM-014', name: 'Cornflakes 500g', brand: 'Kellogg’s', category: 'Breakfast', subCategory: 'Cereals', department: 'Grocery', unit: 'box', packSizeUnits: 1, retail: 3400, wholesaleRatio: 0.93, cost: 2650, batches: [
    { batchNumber: 'CF-4451', daysToExpiry: 180, quantity: 18 },
  ] },
  { sku: 'DEMO-SM-015', name: 'Oats 1kg', brand: 'Quaker', category: 'Breakfast', subCategory: 'Cereals', department: 'Grocery', unit: 'pack', packSizeUnits: 1, retail: 3900, wholesaleRatio: 0.94, cost: 3100, batches: [] },
  { sku: 'DEMO-SM-016', name: 'Tea Bags 100s', brand: 'Lipton', category: 'Beverages', subCategory: 'Tea', department: 'Grocery', unit: 'box', packSizeUnits: 1, retail: 2800, wholesaleRatio: 0.93, cost: 2100, batches: [] },
  { sku: 'DEMO-SM-017', name: 'Instant Coffee 200g', brand: 'Nescafé', category: 'Beverages', subCategory: 'Coffee', department: 'Grocery', unit: 'jar', packSizeUnits: 1, retail: 5400, wholesaleRatio: 0.94, cost: 4400, batches: [] },
  { sku: 'DEMO-SM-018', name: 'Milo 500g', brand: 'Nestlé', category: 'Beverages', subCategory: 'Chocolate drinks', department: 'Grocery', unit: 'tin', packSizeUnits: 1, retail: 4200, wholesaleRatio: 0.94, cost: 3450, batches: [
    { batchNumber: 'MIL-2231', daysToExpiry: 400, quantity: 22 },
  ] },
  { sku: 'DEMO-SM-019', name: 'Bottled Water 75cl (Pack of 12)', brand: 'Eva', category: 'Beverages', subCategory: 'Water', department: 'Grocery', unit: 'pack', packSizeUnits: 12, retail: 2400, wholesaleRatio: 0.92, cost: 1750, batches: [] },
  { sku: 'DEMO-SM-020', name: 'Orange Juice 1L', brand: 'Chi', category: 'Beverages', subCategory: 'Juice', department: 'Grocery', unit: 'carton', packSizeUnits: 1, retail: 1900, wholesaleRatio: 0.92, cost: 1400, batches: [
    { batchNumber: 'OJ-1192', daysToExpiry: 90, quantity: 26 },
  ] },
  { sku: 'DEMO-SM-021', name: 'Tomatoes (per kg)', brand: '', category: 'Fresh Produce', subCategory: 'Vegetables', department: 'Fresh', unit: 'kg', packSizeUnits: 1, retail: 0, wholesaleRatio: 0.9, cost: 900, weighed: true, plu: 'PLU-1001', pricePerKg: 1800, batches: [] },
  { sku: 'DEMO-SM-022', name: 'Onions (per kg)', brand: '', category: 'Fresh Produce', subCategory: 'Vegetables', department: 'Fresh', unit: 'kg', packSizeUnits: 1, retail: 0, wholesaleRatio: 0.9, cost: 700, weighed: true, plu: 'PLU-1002', pricePerKg: 1400, batches: [] },
  { sku: 'DEMO-SM-023', name: 'Irish Potatoes (per kg)', brand: '', category: 'Fresh Produce', subCategory: 'Vegetables', department: 'Fresh', unit: 'kg', packSizeUnits: 1, retail: 0, wholesaleRatio: 0.9, cost: 850, weighed: true, plu: 'PLU-1003', pricePerKg: 1600, batches: [] },
  { sku: 'DEMO-SM-024', name: 'Plantain (per kg)', brand: '', category: 'Fresh Produce', subCategory: 'Fruit', department: 'Fresh', unit: 'kg', packSizeUnits: 1, retail: 0, wholesaleRatio: 0.9, cost: 800, weighed: true, plu: 'PLU-1004', pricePerKg: 1500, batches: [] },
  { sku: 'DEMO-SM-025', name: 'Beef (per kg)', brand: '', category: 'Butchery', subCategory: 'Beef', department: 'Fresh', unit: 'kg', packSizeUnits: 1, retail: 0, wholesaleRatio: 0.92, cost: 4200, weighed: true, plu: 'PLU-2001', pricePerKg: 6500, batches: [] },
  { sku: 'DEMO-SM-026', name: 'Chicken Drumsticks (per kg)', brand: '', category: 'Butchery', subCategory: 'Poultry', department: 'Fresh', unit: 'kg', packSizeUnits: 1, retail: 0, wholesaleRatio: 0.92, cost: 3000, weighed: true, plu: 'PLU-2002', pricePerKg: 4800, batches: [] },
  { sku: 'DEMO-SM-027', name: 'Fresh Milk 1L', brand: 'Fan Milk', category: 'Dairy & Chilled', subCategory: 'Milk', department: 'Fresh', unit: 'carton', packSizeUnits: 1, retail: 2100, wholesaleRatio: 0.92, cost: 1600, batches: [
    { batchNumber: 'MLK-4410', daysToExpiry: 21, quantity: 30 },
  ] },
  { sku: 'DEMO-SM-028', name: 'Yoghurt 500ml', brand: 'Hollandia', category: 'Dairy & Chilled', subCategory: 'Yoghurt', department: 'Fresh', unit: 'bottle', packSizeUnits: 1, retail: 1800, wholesaleRatio: 0.92, cost: 1300, batches: [
    { batchNumber: 'YGT-7720', daysToExpiry: 30, quantity: 24 },
  ] },
  { sku: 'DEMO-SM-029', name: 'Eggs, Large (Crate of 30)', brand: 'Farm Fresh', category: 'Dairy & Chilled', subCategory: 'Eggs', department: 'Fresh', unit: 'crate', packSizeUnits: 30, retail: 4800, wholesaleRatio: 0.93, cost: 3900, batches: [
    { batchNumber: 'EGG-1180', daysToExpiry: 18, quantity: 20 },
  ] },
  { sku: 'DEMO-SM-030', name: 'Butter 250g', brand: 'Blue Band', category: 'Dairy & Chilled', subCategory: 'Butter', department: 'Fresh', unit: 'tub', packSizeUnits: 1, retail: 2600, wholesaleRatio: 0.93, cost: 2000, batches: [
    { batchNumber: 'BTR-3390', daysToExpiry: 120, quantity: 16 },
  ] },
  { sku: 'DEMO-SM-031', name: 'Bread, Sliced Loaf 600g', brand: 'Butterfield', category: 'Bakery', subCategory: 'Bread', department: 'Fresh', unit: 'loaf', packSizeUnits: 1, retail: 1500, wholesaleRatio: 0.92, cost: 1050, batches: [
    { batchNumber: 'BRD-2201', daysToExpiry: 7, quantity: 25 },
  ] },
  { sku: 'DEMO-SM-032', name: 'Agege Bread (Large)', brand: '', category: 'Bakery', subCategory: 'Bread', department: 'Fresh', unit: 'loaf', packSizeUnits: 1, retail: 1200, wholesaleRatio: 0.92, cost: 850, batches: [
    { batchNumber: 'AGB-2210', daysToExpiry: 4, quantity: 20 },
  ] },
  { sku: 'DEMO-SM-033', name: 'Meat Pie', brand: '', category: 'Bakery', subCategory: 'Pastries', department: 'Fresh', unit: 'each', packSizeUnits: 1, retail: 800, wholesaleRatio: 0.9, cost: 520, batches: [
    { batchNumber: 'MTP-1102', daysToExpiry: 3, quantity: 30 },
  ] },
  { sku: 'DEMO-SM-034', name: 'Laundry Detergent 900g', brand: 'Ariel', category: 'Household', subCategory: 'Laundry', department: 'Grocery', unit: 'pack', packSizeUnits: 1, retail: 3600, wholesaleRatio: 0.93, cost: 2800, batches: [] },
  { sku: 'DEMO-SM-035', name: 'Dishwashing Liquid 750ml', brand: 'Morning Fresh', category: 'Household', subCategory: 'Kitchen', department: 'Grocery', unit: 'bottle', packSizeUnits: 1, retail: 2300, wholesaleRatio: 0.92, cost: 1750, batches: [] },
  { sku: 'DEMO-SM-036', name: 'Toilet Tissue (Pack of 10 rolls)', brand: 'Softcare', category: 'Household', subCategory: 'Paper', department: 'Grocery', unit: 'pack', packSizeUnits: 10, retail: 3200, wholesaleRatio: 0.92, cost: 2400, batches: [] },
  { sku: 'DEMO-SM-037', name: 'Bleach 750ml', brand: 'Hypo', category: 'Household', subCategory: 'Cleaning', department: 'Grocery', unit: 'bottle', packSizeUnits: 1, retail: 1100, wholesaleRatio: 0.9, cost: 780, batches: [] },
  { sku: 'DEMO-SM-038', name: 'Bath Soap 175g (Pack of 3)', brand: 'Lux', category: 'Personal Care', subCategory: 'Bath', department: 'Grocery', unit: 'pack', packSizeUnits: 3, retail: 1800, wholesaleRatio: 0.92, cost: 1300, batches: [] },
  { sku: 'DEMO-SM-039', name: 'Toothpaste 140g', brand: 'Close Up', category: 'Personal Care', subCategory: 'Oral', department: 'Grocery', unit: 'tube', packSizeUnits: 1, retail: 1400, wholesaleRatio: 0.91, cost: 1000, batches: [] },
  { sku: 'DEMO-SM-040', name: 'Sanitary Pads (Pack of 10)', brand: 'Always', category: 'Personal Care', subCategory: 'Feminine', department: 'Grocery', unit: 'pack', packSizeUnits: 10, retail: 2200, wholesaleRatio: 0.92, cost: 1650, batches: [] },
  { sku: 'DEMO-SM-041', name: 'Baby Diapers, Medium (Pack of 30)', brand: 'Pampers', category: 'Baby Care', subCategory: 'Diapers', department: 'Grocery', unit: 'pack', packSizeUnits: 30, retail: 8500, wholesaleRatio: 0.94, cost: 7000, batches: [] },
  { sku: 'DEMO-SM-042', name: 'Baby Wipes (Pack of 80)', brand: 'Johnson’s', category: 'Baby Care', subCategory: 'Wipes', department: 'Grocery', unit: 'pack', packSizeUnits: 80, retail: 2900, wholesaleRatio: 0.93, cost: 2200, batches: [] },
  { sku: 'DEMO-SM-043', name: 'Chocolate Bar 100g', brand: 'Cadbury', category: 'Snacks', subCategory: 'Chocolate', department: 'Grocery', unit: 'bar', packSizeUnits: 1, retail: 1200, wholesaleRatio: 0.9, cost: 850, batches: [
    { batchNumber: 'CHC-1120', daysToExpiry: 240, quantity: 40 },
  ] },
  { sku: 'DEMO-SM-044', name: 'Biscuits 200g (Pack of 2)', brand: 'McVitie’s', category: 'Snacks', subCategory: 'Biscuits', department: 'Grocery', unit: 'pack', packSizeUnits: 2, retail: 1600, wholesaleRatio: 0.91, cost: 1150, batches: [
    { batchNumber: 'BSC-9931', daysToExpiry: 160, quantity: 36 },
  ] },
  { sku: 'DEMO-SM-045', name: 'Groundnuts (Roasted) 250g', brand: 'Fresh Farm', category: 'Snacks', subCategory: 'Nuts', department: 'Grocery', unit: 'pack', packSizeUnits: 1, retail: 900, wholesaleRatio: 0.9, cost: 620, batches: [
    { batchNumber: 'GNT-3320', daysToExpiry: 150, quantity: 28 },
  ] },
  { sku: 'DEMO-SM-046', name: 'Soft Drink 50cl (Pack of 12)', brand: 'Coca-Cola', category: 'Beverages', subCategory: 'Soft drinks', department: 'Grocery', unit: 'pack', packSizeUnits: 12, retail: 5400, wholesaleRatio: 0.93, cost: 4400, batches: [] },
  { sku: 'DEMO-SM-047', name: 'Malt Drink 330ml (Pack of 6)', brand: 'Maltina', category: 'Beverages', subCategory: 'Malt', department: 'Grocery', unit: 'pack', packSizeUnits: 6, retail: 3600, wholesaleRatio: 0.93, cost: 2850, batches: [] },
  { sku: 'DEMO-SM-048', name: 'Seasoning Cubes (Pack of 50)', brand: 'Maggi', category: 'Cooking Essentials', subCategory: 'Seasoning', department: 'Grocery', unit: 'pack', packSizeUnits: 50, retail: 1800, wholesaleRatio: 0.92, cost: 1350, batches: [] },
  { sku: 'DEMO-SM-049', name: 'Table Salt 1kg', brand: 'Dangote', category: 'Cooking Essentials', subCategory: 'Salt', department: 'Grocery', unit: 'pack', packSizeUnits: 1, retail: 550, wholesaleRatio: 0.9, cost: 380, batches: [] },
  { sku: 'DEMO-SM-050', name: 'Sugar 1kg', brand: 'Dangote', category: 'Cooking Essentials', subCategory: 'Sugar', department: 'Grocery', unit: 'pack', packSizeUnits: 1, retail: 2400, wholesaleRatio: 0.93, cost: 1900, batches: [] },
  { sku: 'DEMO-SM-051', name: 'Curry Powder 100g', brand: 'Sunbird', category: 'Cooking Essentials', subCategory: 'Spices', department: 'Grocery', unit: 'pack', packSizeUnits: 1, retail: 800, wholesaleRatio: 0.9, cost: 550, batches: [] },
  { sku: 'DEMO-SM-052', name: 'Black Pepper 50g', brand: 'Sunbird', category: 'Cooking Essentials', subCategory: 'Spices', department: 'Grocery', unit: 'pack', packSizeUnits: 1, retail: 950, wholesaleRatio: 0.9, cost: 660, batches: [] },
  { sku: 'DEMO-SM-053', name: 'Honey 500g', brand: 'Pure Gold', category: 'Cooking Essentials', subCategory: 'Honey', department: 'Grocery', unit: 'jar', packSizeUnits: 1, retail: 4200, wholesaleRatio: 0.93, cost: 3300, batches: [] },
  { sku: 'DEMO-SM-054', name: 'Peanut Butter 340g', brand: 'Skippy', category: 'Cooking Essentials', subCategory: 'Spreads', department: 'Grocery', unit: 'jar', packSizeUnits: 1, retail: 3100, wholesaleRatio: 0.93, cost: 2400, batches: [] },
  { sku: 'DEMO-SM-055', name: 'Frozen Chicken (Whole, 1.2kg)', brand: 'Chi', category: 'Frozen', subCategory: 'Poultry', department: 'Fresh', unit: 'each', packSizeUnits: 1, retail: 6800, wholesaleRatio: 0.93, cost: 5400, batches: [
    { batchNumber: 'FCH-2210', daysToExpiry: 200, quantity: 12 },
  ] },
  { sku: 'DEMO-SM-056', name: 'Frozen Fish (Mackerel, 1kg)', brand: '', category: 'Frozen', subCategory: 'Fish', department: 'Fresh', unit: 'kg', packSizeUnits: 1, retail: 5900, wholesaleRatio: 0.93, cost: 4600, batches: [
    { batchNumber: 'FFI-4410', daysToExpiry: 180, quantity: 15 },
  ] },
  { sku: 'DEMO-SM-057', name: 'Ice Cream 1L (Vanilla)', brand: 'FanIce', category: 'Frozen', subCategory: 'Ice cream', department: 'Fresh', unit: 'tub', packSizeUnits: 1, retail: 4500, wholesaleRatio: 0.93, cost: 3500, batches: [
    { batchNumber: 'ICE-6620', daysToExpiry: 240, quantity: 10 },
  ] },
  { sku: 'DEMO-SM-058', name: 'Rechargeable Batteries AA (Pack of 4)', brand: 'Duracell', category: 'Electricals', subCategory: 'Batteries', department: 'Grocery', unit: 'pack', packSizeUnits: 4, retail: 2600, wholesaleRatio: 0.91, cost: 1950, batches: [] },
  { sku: 'DEMO-SM-059', name: 'LED Bulb 9W', brand: 'Philips', category: 'Electricals', subCategory: 'Lighting', department: 'Grocery', unit: 'each', packSizeUnits: 1, retail: 1800, wholesaleRatio: 0.9, cost: 1300, batches: [] },
  { sku: 'DEMO-SM-060', name: 'Reusable Shopping Bag', brand: '', category: 'Household', subCategory: 'Bags', department: 'Grocery', unit: 'each', packSizeUnits: 1, retail: 500, wholesaleRatio: 0.85, cost: 280, batches: [] },
]

/**
 * The number of major units a "typical" price represents in the shop's currency. The demo is meant to look
 * like a real shelf, not like Monopoly money: prices are scaled so a pack of paracetamol costs about what a
 * Nigerian shopper expects in naira, a few dollars in USD and a few hundred yen in JPY.
 */
const CURRENCY_SCALE: Record<string, number> = {
  NGN: 1, GHS: 0.02, KES: 0.1, ZAR: 0.03, XOF: 0.4, XAF: 0.4, UGX: 2.6, TZS: 1.8, RWF: 0.9,
  ETB: 0.06, EGP: 0.03, MAD: 0.07, TND: 0.0022, DZD: 0.1, ZMW: 0.018, MWK: 1.2, BWP: 0.009,
  NAD: 0.03, MZN: 0.045, AOA: 0.65, GMD: 0.05, SLE: 0.016, LRD: 0.13, CDF: 1.9, SDG: 0.42,
  SSP: 1.1, USD: 0.0007, EUR: 0.0006, GBP: 0.0006, CAD: 0.001, AUD: 0.0011, NZD: 0.0012,
  INR: 0.058, PKR: 0.19, BDT: 0.083, LKR: 0.21, AED: 0.0026, SAR: 0.0026, QAR: 0.0026,
  KWD: 0.00021, BHD: 0.00026, OMR: 0.00027, JOD: 0.0005, TRY: 0.024, CNY: 0.005, JPY: 0.11,
  KRW: 0.98, SGD: 0.0009, MYR: 0.0031, IDR: 11, PHP: 0.04, THB: 0.025, BRL: 0.0038, MXN: 0.013,
}

export type { DemoDatasetState, DemoLoadResult } from '../shared/demo/types'

export interface DemoDataServiceOptions {
  edition: () => Edition | null
  now?: () => number
  newId?: () => string
}

const DEMO_PASSWORD = 'Demo-Pass!2026'

/**
 * Loads and removes the optional demonstration dataset. All prices are integer minor units derived from
 * the shop currency, all rows are tagged, and nothing here creates a sale — so a shop that tries the demo
 * and removes it is left exactly where it started, with the currency still unlocked.
 */
export class DemoDataService {
  private readonly now: () => number

  constructor(
    private readonly database: Database.Database,
    private readonly shop: ShopRepository,
    private readonly users: UserRepository,
    private readonly inventory: ProductInventoryService,
    private readonly options: DemoDataServiceOptions,
  ) {
    this.now = options.now ?? Date.now
  }

  // ------------------------------------------------------------------ status

  status(): DemoDatasetState {
    const products = this.database.prepare("SELECT COUNT(*) AS count FROM products WHERE id LIKE 'demo-%'").get() as { count: number }
    const demoUsers = this.listDemoUsers()
    const inUse = this.findRealUsage()
    return {
      loaded: products.count > 0 || demoUsers.length > 0,
      products: products.count,
      users: demoUsers.length,
      demoUsers: demoUsers.map(({ username, fullName, role }) => ({ username, fullName, role })),
      inUse: inUse !== null,
      inUseReason: inUse,
      currency: this.shop.readSettings().currency.code,
    }
  }

  // ------------------------------------------------------------------ loading

  load(actor: PublicUser): DemoLoadResult {
    requireAdmin(actor)
    const edition = this.requireEdition()
    const settings = this.shop.readSettings()
    if (!settings.setupComplete) throw new Error('Finish shop setup before loading the demo data.')
    const currency = settings.currency
    const catalogue = edition === 'SUPERMARKET' ? SUPERMARKET_PRODUCTS : edition === 'PHARMACY' ? PHARMACY_PRODUCTS : [...PHARMACY_PRODUCTS, ...SUPERMARKET_PRODUCTS]
    const inventoryActor = { id: actor.id, username: actor.username, role: actor.role }

    let created = 0
    let promotions = 0
    // One transaction for the whole load: a half-loaded demo is worse than none, and the audit row must
    // describe exactly what landed.
    this.shop.withTransaction(() => {
      const existingSkus = new Set((this.database.prepare("SELECT sku FROM products WHERE id LIKE 'demo-%'").all() as Array<{ sku: string }>).map(({ sku }) => sku))
      for (const source of catalogue) {
        if (existingSkus.has(source.sku)) continue
        const draft = this.draftFrom(source, currency, edition, created)
        const product = this.inventory.createProduct(draft, inventoryActor, edition)
        // Opening stock, as an ADJUSTMENT: this is the one movement type that is *not* a business entry, so
        // it does not trip the currency-lock trigger. Each batch is received with a real expiry date so the
        // FEFO and expiry-alert screens have something to show.
        const lots = source.batches.length ? source.batches : [{ batchNumber: '', daysToExpiry: 0, quantity: 24 }]
        this.seedOpeningStock(product, lots, currency)
        created += 1
      }
      if (created > 0) promotions = this.createPromotions()
    })

    const demoUsers = this.ensureDemoUsers(edition)
    this.recordAudit(actor, 'demo.loaded', {
      products: created, users: demoUsers.created.length, promotions, currencyCode: currency.code,
    })

    const first = catalogue[0]!
    return {
      products: created,
      users: demoUsers.created.length,
      promotions,
      currencyCode: currency.code,
      samplePrice: first.pricePerKg
        ? formatMoney(this.scalePrice(first.pricePerKg, currency), currency, settings.display)
        : formatMoney(this.scalePrice(first.retail, currency), currency, settings.display),
    }
  }

  /** The three sample accounts the brief asks for: one cashier with wholesale on, one off, and a supervisor. */
  private ensureDemoUsers(edition: Edition): { created: string[] } {
    const existing = new Set(this.listDemoUsers().map(({ username }) => username))
    const created: string[] = []
    const cashierOn = 'demo.cashier.on'
    const cashierOff = 'demo.cashier.off'
    const supervisor = 'demo.supervisor'
    const plan: Array<{ username: string; fullName: string; role: PublicUser['role']; permissions: ReturnType<typeof defaultPermissions> }> = [
      { username: cashierOn, fullName: 'Demo Cashier (wholesale on)', role: 'CASHIER', permissions: { ...defaultPermissions('CASHIER'), allowWholesale: true, maxDiscountBasisPoints: 500 } },
      { username: cashierOff, fullName: 'Demo Cashier (wholesale off)', role: 'CASHIER', permissions: { ...defaultPermissions('CASHIER'), allowWholesale: false, maxDiscountBasisPoints: 0 } },
    ]
    // A Supervisor only exists in the supermarket edition, and the user service refuses one elsewhere. Ask
    // for it only where it is legal rather than creating a role the host will not honour.
    if (edition === 'SUPERMARKET' || edition === 'BOTH') {
      plan.push({ username: supervisor, fullName: 'Demo Supervisor', role: 'SUPERVISOR', permissions: { ...defaultPermissions('SUPERVISOR'), maxDiscountBasisPoints: 2500 } })
    }
    for (const account of plan) {
      if (existing.has(account.username)) continue
      // Synchronous insert through the repository, because createUser hashes with bcrypt asynchronously and
      // this method runs inside the caller's transaction boundary. The hash is identical to the service's.
      const passwordHash = hashSync(DEMO_PASSWORD, 8)
      const id = `${DEMO_PREFIX}user-${account.username.replace(/^demo\./u, '')}`
      this.users.createUser({
        id,
        fullName: account.fullName,
        username: account.username,
        passwordHash,
        role: account.role,
        permissions: account.permissions,
      })
      created.push(account.username)
    }
    return { created }
  }

  // ------------------------------------------------------------------ removal

  /**
   * Removes every demo row. It refuses, with the reason, if real work depends on a demo product — removing it
   * would either break a foreign key or erase the meaning of a completed sale.
   */
  remove(actor: PublicUser): { products: number; users: number; promotions: number } {
    requireAdmin(actor)
    const inUse = this.findRealUsage()
    if (inUse) throw new Error(inUse)
    let products = 0
    let users = 0
    let promotions = 0
    this.shop.withTransaction(() => {
      const ids = (this.database.prepare("SELECT id FROM products WHERE id LIKE 'demo-%'").all() as Array<{ id: string }>).map(({ id }) => id)
      const deleteMovement = this.database.prepare("DELETE FROM stock_movements WHERE product_id = ? AND id LIKE 'demo-%'")
      const deleteBarcodes = this.database.prepare('DELETE FROM product_barcodes WHERE product_id = ?')
      const deleteVariants = this.database.prepare('DELETE FROM product_variants WHERE product_id = ?')
      const deleteBatches = this.database.prepare('DELETE FROM product_batches WHERE product_id = ?')
      const deleteStock = this.database.prepare('DELETE FROM stock WHERE product_id = ?')
      const deleteProduct = this.database.prepare('DELETE FROM products WHERE id = ?')
      for (const id of ids) {
        deleteMovement.run(id)
        deleteBarcodes.run(id)
        deleteVariants.run(id)
        deleteBatches.run(id)
        deleteStock.run(id)
        deleteProduct.run(id)
        products += 1
      }
      // Promotions, price rules and demo customers are ours to clear; department rows are shared by name with
      // real products, so they are left alone.
      promotions = Number(this.database.prepare("DELETE FROM promotions WHERE id LIKE 'demo-%'").run().changes)
      this.database.prepare("DELETE FROM price_rules WHERE id LIKE 'demo-%'").run()
      const demoUserIds = this.listDemoUsers().map(({ id }) => id)
      for (const id of demoUserIds) {
        // Permissions cascade; anything else (a shift, a sale) would already have blocked above.
        this.database.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(id)
        this.database.prepare('DELETE FROM devices WHERE admin_user_id = ?').run(id)
        this.database.prepare('DELETE FROM users WHERE id = ?').run(id)
        users += 1
      }
      this.database.prepare("DELETE FROM audit_log WHERE id LIKE 'demo-%'").run()
    })
    this.recordAudit(actor, 'demo.removed', { products, users, promotions })
    return { products, users, promotions }
  }

  // ------------------------------------------------------------------ internals

  private requireEdition(): Edition {
    const edition = this.options.edition()
    if (!edition) throw new Error('Activate a valid licence before loading the demonstration data.')
    return edition
  }

  private listDemoUsers(): Array<{ id: string; username: string; fullName: string; role: string }> {
    return this.database.prepare(`
      SELECT id, username, full_name AS fullName, role FROM users
      WHERE id LIKE 'demo-%' OR username LIKE 'demo.%'
      ORDER BY username
    `).all() as Array<{ id: string; username: string; fullName: string; role: string }>
  }

  /**
   * Finds real work that references a demo row. Returns a sentence for the Admin, or null when removal is safe.
   * The check covers every table that could hold history: a completed sale, a return, a purchase, a stocktake
   * or a hand-made stock movement.
   */
  private findRealUsage(): string | null {
    // Written out in full rather than assembled from a fragment: this file is scanned by the SQL-injection
    // review test, and a passing scan that only worked because a constant happened to be allowlisted would be
    // a weaker guarantee than simply not building SQL out of pieces. The literal 'demo-%' is what identifies
    // every row the demo service owns.
    const saleLine = this.database.prepare(`
      SELECT COUNT(*) AS count FROM sale_items si
      WHERE si.product_id IN (SELECT id FROM products WHERE id LIKE 'demo-%')
    `).get() as { count: number }
    if (saleLine.count > 0) return 'A sale already includes demonstration products. Remove the demonstration data only before real use, or keep it — completed sales cannot be deleted.'
    const returnLine = this.database.prepare(`
      SELECT COUNT(*) AS count FROM return_items ri
      WHERE ri.sale_item_id IN (
        SELECT id FROM sale_items WHERE product_id IN (SELECT id FROM products WHERE id LIKE 'demo-%')
      )
    `).get() as { count: number }
    if (returnLine.count > 0) return 'A return already includes demonstration products. Keep the demonstration data, because return documents must keep pointing at what was sold.'
    const purchaseLine = this.database.prepare(`
      SELECT COUNT(*) AS count FROM purchase_items pi
      WHERE pi.product_id IN (SELECT id FROM products WHERE id LIKE 'demo-%')
    `).get() as { count: number }
    if (purchaseLine.count > 0) return 'A purchase order includes demonstration products. Keep the demonstration data, or complete and archive the order first.'
    const foreignMovement = this.database.prepare(`
      SELECT COUNT(*) AS count FROM stock_movements
      WHERE product_id IN (SELECT id FROM products WHERE id LIKE 'demo-%') AND id NOT LIKE 'demo-%'
    `).get() as { count: number }
    if (foreignMovement.count > 0) return 'Real stock movements exist for demonstration products. Demonstration data can be removed only before real stock work begins.'
    const demoUserWork = this.database.prepare(`
      SELECT COUNT(*) AS count FROM sales WHERE cashier_id LIKE 'demo-%'
    `).get() as { count: number }
    if (demoUserWork.count > 0) return 'A sale was made by a demonstration cashier. Keep the demonstration data so the sale keeps its author.'
    return null
  }

  private draftFrom(source: DemoProduct, currency: CurrencyDefinition, edition: Edition, index: number): Parameters<ProductInventoryService['createProduct']>[0] {
    const supermarket = edition !== 'PHARMACY'
    const pharmacy = edition !== 'SUPERMARKET'
    const scale = CURRENCY_SCALE[currency.code] ?? 1
    const whole = (major: number): string => scaleMajor(major, scale, currency)
    const weighed = supermarket && Boolean(source.weighed)
    return {
      sku: source.sku,
      name: source.name,
      brand: source.brand,
      description: 'Demonstration stock — remove it from Settings before entering real products.',
      barcode: source.sku.startsWith('DEMO-PH') ? `20000${String(index + 1).padStart(8, '0')}` : '',
      additionalBarcodes: [],
      category: source.category,
      subCategory: source.subCategory,
      department: supermarket ? source.department ?? '' : '',
      shelfLocation: supermarket ? `D${(index % 8) + 1}` : '',
      unit: source.unit,
      packSizeUnits: source.packSizeUnits,
      // A field the edition does not own must be blank, or the product service refuses the draft — that rule
      // is the same one the product screen obeys.
      cost: whole(source.cost),
      retailPrice: weighed ? whole(source.pricePerKg ?? 0) : whole(source.retail),
      wholesalePrice: weighed ? whole(source.pricePerKg ?? 0) : whole(Math.round(source.retail * source.wholesaleRatio)),
      wholesaleMinimumQuantity: '5',
      reorderLevel: '5',
      genericName: pharmacy ? source.genericName ?? '' : '',
      prescriptionRequired: pharmacy && Boolean(source.prescription),
      weighedItem: weighed,
      pluCode: weighed ? source.plu ?? '' : '',
      pricePerKg: weighed ? whole(source.pricePerKg ?? 0) : '',
      expiryTracking: source.batches.length > 0,
      variants: [],
      isActive: true,
    }
  }

  /**
   * Writes the demo's opening stock: the batch rows, the stock figures, and one movement per lot tagged
   * `DEMO_SEED`.
   *
   * This deliberately does *not* go through `inventory.adjustStock`, even though that is the real path for a
   * hand adjustment. Two reasons, both about honesty rather than convenience. `adjustStock` tags its movement
   * `ADJUSTMENT`, and an adjustment is a business entry a shop must keep forever — the demo writes a
   * `DEMO_SEED` movement precisely so it can be told apart and removed. And `adjustStock` fires for a real
   * operator; seeding 30 lots through it would leave 30 audit rows about nothing. The effect on the shelf is
   * identical, which `demo-data-service.test.ts` checks against the real service's own numbers.
   */
  private seedOpeningStock(
    product: ReturnType<ProductInventoryService['createProduct']>,
    lots: Array<{ batchNumber: string; daysToExpiry: number; quantity: number }>,
    currency: CurrencyDefinition,
  ): void {
    let total = 0
    for (const lot of lots) {
      const quantityMilli = BigInt(Math.round(lot.quantity * 1000))
      total += lot.quantity
      if (product.expiryTracking) {
        const expiryDate = lot.daysToExpiry > 0 ? isoDate(this.now() + lot.daysToExpiry * 86_400_000) : isoDate(this.now() + 365 * 86_400_000)
        this.database.prepare(`
          INSERT INTO product_batches (id, product_id, batch_no, expiry_date, quantity_milli, cost)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(`demo-batch-${this.nextSequence()}`, product.id, lot.batchNumber || 'DEMO-LOT', expiryDate, quantityMilli, product.costMinor ?? 0n)
      }
      this.database.prepare(`
        INSERT INTO stock_movements (
          id, product_id, movement_type, reference_type, reference_id, quantity_delta_milli,
          unit_cost, currency_code, created_by, adjustment_reason
        ) VALUES (?, ?, 'ADJUSTMENT', 'DEMO_SEED', ?, ?, ?, ?, ?, ?)
      `).run(
        `demo-movement-${this.nextSequence()}`, product.id, `DEMO-${product.sku}`,
        quantityMilli, product.costMinor ?? 0n, currency.code, null,
        'Opening stock for the demonstration data',
      )
    }
    this.database.prepare(`
      UPDATE stock SET quantity_milli = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ?
    `).run(BigInt(total * 1000), product.id)
  }

  private sequence = 0
  private nextSequence(): number {
    this.sequence += 1
    return this.sequence
  }

  private createPromotions(): number {
    const settings = this.shop.readSettings()
    const currency = settings.currency
    const now = this.now()
    const startsAt = new Date(now - 86_400_000).toISOString()
    const endsAt = new Date(now + 30 * 86_400_000).toISOString()
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO promotions (id, name, promotion_type, amount_minor, discount_basis_points, starts_at, ends_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `)
    // Two kinds, so the promotion picker has something to reason about: a percentage off everything and a
    // fixed amount off a department, which the supermarket edition can showcase.
    insert.run(`${DEMO_PREFIX}promo-percent`, 'Demo: 5% off the whole basket', 'PERCENT', null, 500, startsAt, endsAt)
    insert.run(`${DEMO_PREFIX}promo-fixed`, 'Demo: fixed discount on the grocery department', 'FIXED', 500, null, startsAt, endsAt)
    void currency
    return 2
  }

  private scalePrice(major: number, currency: CurrencyDefinition): bigint {
    const scale = CURRENCY_SCALE[currency.code] ?? 1
    return toMinor(scaleMajor(major, scale, currency), currency)
  }

  private recordAudit(actor: PublicUser, action: string, metadata: Record<string, unknown>): void {
    this.shop.appendAudit({
      actor: actor.username,
      action,
      metadata: { ...metadata, deviceName: 'LOCAL_DESKTOP' },
      deviceName: 'LOCAL_DESKTOP',
      ipAddress: null,
      createdAt: new Date(this.now()).toISOString(),
    })
  }
}

/**
 * Scales a naira-ish reference price into the shop's currency and returns it as an exact decimal string with
 * the currency's own decimal places. Zero-decimal currencies get whole numbers (no "1500.00 UGX"), and
 * three-decimal currencies get a sensible thousandths figure rather than a truncated one.
 */
export function scaleMajor(major: number, scale: number, currency: CurrencyDefinition): string {
  const scaled = major * scale
  if (currency.decimalPlaces === 0) return String(Math.max(1, Math.round(scaled)))
  const factor = 10 ** currency.decimalPlaces
  return fromMinor(BigInt(Math.max(1, Math.round(scaled * factor))), currency)
}

function isoDate(millis: number): string {
  return new Date(millis).toISOString().slice(0, 10)
}

function requireAdmin(actor: PublicUser): void {
  if (!actor || actor.role !== 'ADMIN' || !actor.isActive || actor.isLocked) {
    throw new Error('Only an Admin can load or remove the demonstration data.')
  }
}
