require('dotenv').config();
const mongoose = require('mongoose');

// 建立簡單的 Model 對應到資料庫中的 flightHistory collection
const flightHistorySchema = new mongoose.Schema({}, { strict: false });
const FlightHistory = mongoose.model('FlightHistory', flightHistorySchema, 'flightHistory');

async function clean() {
  try {
    if (!process.env.MONGODB_URI) {
      console.error('找不到 MONGODB_URI 環境變數');
      process.exit(1);
    }
    
    console.log('連線到資料庫中...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ 成功連線到資料庫');
    
    // 條件：起點和終點都是空字串，或者是不存在的
    const filter = {
      departure: { $in: ['', null] },
      arrival: { $in: ['', null] }
    };
    
    const count = await FlightHistory.countDocuments(filter);
    console.log(`🔍 找到 ${count} 筆沒有起點與終點的飛行紀錄`);
    
    if (count > 0) {
      const result = await FlightHistory.deleteMany(filter);
      console.log(`🗑️ 成功刪除 ${result.deletedCount} 筆紀錄`);
    } else {
      console.log('✨ 沒有需要刪除的紀錄');
    }
    
    process.exit(0);
  } catch(e) {
    console.error('❌ 發生錯誤:', e);
    process.exit(1);
  }
}

clean();
