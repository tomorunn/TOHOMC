const { MongoClient } = require('mongodb');
require('dotenv').config();

const uri = process.env.MONGO_URI; // 環境変数から接続文字列を取得
const client = new MongoClient(uri);

module.exports = async (req, res) => {
  try {
    await client.connect();
    const database = client.db('contest');
    const collection = database.collection('submissions');

    // ユーザーからのデータを受け取る
    const submission = {
      data: req.body.data, // クライアントから送られたデータ
      timestamp: new Date()
    };

    // MongoDBに保存
    const result = await collection.insertOne(submission);
    res.status(200).json({ message: 'Submission saved', id: result.insertedId });
  } catch (error) {
    res.status(500).json({ error: 'Something went wrong' });
  } finally {
    await client.close();
  }
};