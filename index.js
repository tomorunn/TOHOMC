const express = require('express');
const { DateTime } = require('luxon');
const path = require('path');
const cookieParser = require('cookie-parser');
const { MongoClient } = require('mongodb');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises; // ファイルシステムモジュール
const cloudinary = require('cloudinary').v2;

const app = express();


require('dotenv').config();

// Cloudinaryの設定をコードの先頭に追加（app.listenの前あたりに記述）
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});


// ミドルウェアの設定（順序が重要）
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'))); // ファビコン対応
app.use(fileUpload({
    useTempFiles: true,
    tempFileDir: '/tmp/',
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB制限
    abortOnLimit: true, // 制限を超えたら即時中止
}));

// uploadsディレクトリを作成（存在しない場合）
const uploadDir = path.join(__dirname, 'public', 'uploads');
fs.mkdir(uploadDir, { recursive: true }).catch(err => console.error('アップロードディレクトリ作成エラー:', err));

// MongoDB 接続設定
// MongoDB 接続設定
const uri = process.env.MONGO_URI;
if (!uri) {
    console.error("エラー: MONGO_URIが環境変数に設定されていません。");
    process.exit(1);
}

const client = new MongoClient(uri, {
    connectTimeoutMS: 5000, // 接続タイムアウトを5秒に短縮
    serverSelectionTimeoutMS: 5000, // サーバー選択タイムアウトも5秒
});
let db;
let isConnecting = false;

// MongoDB接続関数（再試行ロジック付き）
async function connectToMongo(attempt = 1, maxAttempts = 3, retryDelay = 2000) {
    if (db) {
        console.log("既存のMongoDB接続を再利用します。");
        return db;
    }

    if (isConnecting) {
        console.log("接続処理が進行中です。待機します...");
        while (isConnecting) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return db;
    }

    isConnecting = true;
    console.log(`MongoDBに接続を試みます（試行 ${attempt}/${maxAttempts}）...`);
    console.log("接続先URI:", uri.replace(/\/\/.*@/, "//[認証情報隠し]@"));

    try {
        await client.connect();
        db = client.db('contest');
        console.log("MongoDBに接続できました！");
        isConnecting = false;
        return db;
    } catch (err) {
        isConnecting = false;
        console.error(`MongoDB接続失敗（試行 ${attempt}/${maxAttempts}）:`, err.message);
        if (attempt < maxAttempts) {
            console.log(`接続に失敗しました。${retryDelay / 1000}秒後に再試行します...`);
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            return connectToMongo(attempt + 1, maxAttempts, retryDelay);
        } else {
            console.error("最大試行回数に達しました。接続を諦めます。");
            throw err;
        }
    }
}

// すべてのリクエストで接続を保証するミドルウェア
app.use(async (req, res, next) => {
    try {
        await connectToMongo();
        next();
    } catch (err) {
        console.error("リクエスト処理中のMongoDB接続エラー:", err);
        res.status(503).send("データベースに接続できませんでした。後で再試行してください。");
    }
});

// サーバー起動時に接続を試みる（削除可能）
/*
connectToMongo().catch((err) => {
    console.error('MongoDB初期接続エラー:', err);
    process.exit(1);
});
*/
app.post('/admin/set-rating', async (req, res) => {
    const { username, rating } = req.body;
    try {
        const database = await connectToMongo();
        const collection = database.collection('users');
        const result = await collection.updateOne(
            { username },
            { $set: { rating: parseInt(rating) } }
        );
        if (result.matchedCount === 0) {
            return res.status(404).send('ユーザーが見つかりません');
        }
        res.send(`ユーザー ${username} のratingを ${rating} に設定しました`);
    } catch (err) {
        console.error('rating設定エラー:', err);
        res.status(500).send('サーバーエラー');
    }
});

// ユーザー情報の読み込み
// ユーザー情報の読み込み
const loadUsers = async () => {
    try {
        const database = await connectToMongo();
        const collection = database.collection('users');
        const users = await collection.find({}).toArray();
        return users.length > 0 ? users.map(user => ({
            ...user,
            rating: user.rating || 100,
            contestHistory: user.contestHistory || [], // コンテスト履歴を初期化
        })) : [
            { username: 'admin', password: 'admin123', isAdmin: true, rating: 0, contestHistory: [] },
            { username: 'user', password: 'pass123', isAdmin: false, rating: 0, contestHistory: [] },
        ];
    } catch (err) {
        console.error('ユーザーの読み込みエラー:', err);
        return [
            { username: 'admin', password: 'admin123', isAdmin: true, rating: 0, contestHistory: [] },
            { username: 'user', password: 'pass123', isAdmin: false, rating: 0, contestHistory: [] },
        ];
    }
};

// ユーザーの保存
const saveUsers = async (users) => {
    try {
        console.log(`ユーザーデータを保存します。ユーザー数: ${users.length}`);
        // 例: JSONファイルに保存する場合
        await fs.promises.writeFile('users.json', JSON.stringify(users, null, 2));
        console.log('ユーザーデータの保存が成功しました。');
    } catch (err) {
        console.error('ユーザーデータの保存に失敗しました:', err);
        throw err;
    }
};

// コンテストの読み込み
const loadContests = async () => {
    try {
        const database = await connectToMongo();
        const collection = database.collection('contests');
        const contests = await collection.find({}).toArray();
        return contests.map(contest => ({
            ...contest,
            testers: contest.testers || [],
            writers: contest.writers || [],
            problems: contest.problems?.map(problem => ({
                ...problem,
                difficulty: problem.difficulty || 0, // 問題にdifficultyを追加
            })) || [],
            managers: contest.managers || [],
            submissions: contest.submissions || [],
            review: contest.review || '',
            submissionLimit: contest.submissionLimit || 10,
            userPerformances: contest.userPerformances || [], // ユーザーのPerformanceを保存
        }));
    } catch (err) {
        console.error('コンテストの読み込みエラー:', err);
        return [];
    }
};

// Difficulty, Performance, Rating 計算関数
// Difficultyの計算: WR * (W/P) + NSR * ((P-S)/P) + SR * (C/P)
// Difficultyの計算: WR * (W/P) + NSR * ((P-S)/P) + SR * (C/P)
const calculateDifficulty = (contest, problemId, users) => {
    console.log(`問題 ${problemId} のdifficulty計算を開始します...`);
    const submissions = contest.submissions || [];
    const problemSubmissions = submissions.filter(sub => sub.problemId === problemId);

    // P: コンテストに参加した人数（提出したユーザー＋ランキングに載るユーザー）
    const participants = new Set(submissions.map(sub => sub.user));
    const P = participants.size;
    console.log(`参加者数 (P): ${P}`);

    // S: 回答した人数
    const solvers = new Set(problemSubmissions.map(sub => sub.user));
    const S = solvers.size;
    console.log(`回答者数 (S): ${S}`);

    // C: CAで終わった人数
    const caUsers = new Set(
        problemSubmissions
            .filter(sub => sub.result === 'CA')
            .map(sub => sub.user)
    );
    const C = caUsers.size;
    console.log(`CAで終わった人数 (C): ${C}`);

    // W: WAで終わった人数（CAせずにWAした人数）
    const waUsers = new Set(
        problemSubmissions
            .filter(sub => sub.result === 'WA' && !caUsers.has(sub.user))
            .map(sub => sub.user)
    );
    const W = waUsers.size;
    console.log(`WAで終わった人数 (W): ${W}`);

    // 参加者がいない場合や、回答者が極端に少ない場合の処理
    if (P === 0) {
        console.log(`参加者数が0のため、difficultyをデフォルト値200に設定します。`);
        return 200; // デフォルト値を200に変更（より現実的な難易度）
    }

    // 各ratingの平均を計算するヘルパー関数
    const getAverageRating = (userList) => {
        if (userList.length === 0) {
            console.log(`ユーザー数が0のため、平均ratingを100に設定します。`);
            return 100; // ユーザーがいない場合のデフォルト値を100に設定
        }
        const totalRating = userList.reduce((sum, username) => {
            const user = users.find(u => u.username === username);
            const userRating = user ? (user.rating || 100) : 100; // ユーザーが見つからない場合も100を返す
            console.log(`ユーザー ${username} のrating: ${userRating}`);
            return sum + userRating;
        }, 0);
        const average = totalRating / userList.length;
        console.log(`平均rating: ${average}`);
        return average;
    };

    // SR: 回答した人のratingの平均
    const solverList = Array.from(solvers);
    const SR = getAverageRating(solverList);
    console.log(`回答者の平均rating (SR): ${SR}`);

    // NSR: 回答しなかった人のratingの平均
    const nonSolvers = Array.from(participants).filter(username => !solvers.has(username));
    const NSR = getAverageRating(nonSolvers);
    console.log(`非回答者の平均rating (NSR): ${NSR}`);

    // WR: WAした人のratingの平均
    const waList = Array.from(waUsers);
    const WR = getAverageRating(waList);
    console.log(`WAした人の平均rating (WR): ${WR}`);

    // difficulty計算: WR * (W/P) + NSR * ((P-S)/P) + SR * (C/P)
    const term1 = WR * (W / P);         // 不正解者の寄与
    const term2 = NSR * ((P - S) / P);  // 非回答者の寄与
    const term3 = SR * (C / P);         // 正解者の寄与
    let difficulty = term1 + term2 + term3;
    console.log(`計算結果: WR * (W/P) = ${term1}, NSR * ((P-S)/P) = ${term2}, SR * (C/P) = ${term3}, difficulty = ${difficulty}`);

    // 計算結果がNaNや無限大の場合、デフォルト値を返す
    if (isNaN(difficulty) || !isFinite(difficulty)) {
        console.log(`difficultyがNaNまたは無限大のため、デフォルト値200に設定します。`);
        return 200; // デフォルト値を200に変更
    }

    // 難易度をスケーリング（よりダイナミックな値にする）
    difficulty = difficulty * 2; // 難易度を2倍にして差を大きくする
    return Math.floor(Math.max(100, Math.min(3000, difficulty))); // 100～3000の範囲に制限
};

// Performanceの計算: 解けた問題のdifficultyの総和 / コンテストにおける順位
// Performance計算関数（修正）
const calculatePerformance = (contest, username, rank, contests) => {
    console.log(`ユーザー ${username} のPerformance計算を開始します...`);
    const submissions = contest.submissions || [];
    const endTime = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' }).toJSDate().getTime();

    // コンテスト期間中の正解提出のみを対象
    const userSubmissions = submissions.filter(
        sub => sub.user === username && sub.result === 'CA' && new Date(sub.date).getTime() <= endTime
    );
    const solvedProblems = new Set(userSubmissions.map(sub => sub.problemId));

    // 解けた問題のDifficultyの総和
    let totalDifficulty = Array.from(solvedProblems).reduce((sum, problemId) => {
        const problem = contest.problems.find(p => p.id === problemId);
        return sum + (problem && problem.difficulty ? problem.difficulty : 100);
    }, 0);

    // 解いた問題がない場合、最低限のDifficultyを付与
    if (solvedProblems.size === 0) {
        totalDifficulty = 100; // 未解決でも最低限のベースポイント
    }

    // Performance計算: 総Difficultyを順位でスケーリング
    const basePerformance = 100; // ベースポイント
    const performance = totalDifficulty * Math.log10(1 + solvedProblems.size) / Math.log10(rank + 1) + basePerformance;

    if (isNaN(performance) || !isFinite(performance)) {
        console.log(`Performanceが異常値のため、デフォルト値100を返します。`);
        return 100;
    }

    const cappedPerformance = Math.max(100, Math.min(3000, performance));
    console.log(`ユーザー ${username} のPerformance: ${cappedPerformance}`);
    return Math.floor(cappedPerformance);
};

// Rating更新関数（修正）
const updateUserRating = (user, performance) => {
    console.log(`ユーザー ${user.username} のRating更新を開始します...`);
    const previousRating = user.rating || 100;
    const effectivePerformance = Math.max(100, performance); // Performanceが低すぎないように
    const newRating = (previousRating * 0.8) + (effectivePerformance * 0.2); // 変化を大きく

    console.log(`Rating更新: (${previousRating} * 0.8) + (${effectivePerformance} * 0.2) = ${newRating}`);
    user.rating = Math.floor(newRating);
    return user.rating;
};

// コンテストの保存
const saveContests = async (contests) => {
    try {
        const database = await connectToMongo();
        const collection = database.collection('contests');
        await collection.drop(); // 既存データをクリア
        if (contests.length > 0) {
            await collection.insertMany(contests);
        }
        console.log("コンテスト保存成功:", contests.length, "件");
    } catch (err) {
        console.error('コンテスト保存エラー:', err);
        throw err;
    }
};

// ナビゲーション生成関数
// ratingに基づく色を決定する関数
const getRatingColor = (rating) => {
    if (rating >= 2801) return 'red';
    if (rating >= 2401) return 'orange';
    if (rating >= 2001) return 'yellow';
    if (rating >= 1601) return 'blue';
    if (rating >= 1201) return 'cyan';
    if (rating >= 801) return 'green';
    if (rating >= 401) return 'brown';
    return 'gray';
};

const generateNav = (user) => {
    if (user) {
        const ratingColor = getRatingColor(user.rating || 0);
        return `
            <nav class="nav">
                <div class="nav-container">
                    <h1>TOHOMC</h1>
                    <button class="nav-toggle">☰</button>
                    <ul class="nav-menu">
                        <li><a href="/">ホーム</a></li>
                        <li><a href="/contests">コンテスト</a></li>
                        <li><a href="/problems">PROBLEMS</a></li>
                        <li><a href="/admin">管理者ダッシュボード</a></li>
                        <li class="username"><a href="/mypage" style="color: ${ratingColor};">Hi, ${user.username}</a></li>
                        <li><a href="/logout">ログアウト</a></li>
                    </ul>
                </div>
            </nav>
            <script>
    document.addEventListener('DOMContentLoaded', () => {
        const toggle = document.querySelector('.nav-toggle');
        const menu = document.querySelector('.nav-menu');
        if (toggle && menu) {
            toggle.addEventListener('click', () => {
                menu.classList.toggle('active');
                console.log('Menu toggled:', menu.classList.contains('active') ? 'opened' : 'closed');
            });
        } else {
            console.error('Navigation elements not found:', { toggle, menu });
        }
    });
</script>
        `;
    }
    return `
        <nav class="nav">
            <div class="nav-container">
                <h1>TOHOMC</h1>
                <button class="nav-toggle">☰</button>
                <ul class="nav-menu">
                    <li><a href="/">ホーム</a></li>
                    <li><a href="/contests">コンテスト</a></li>
                    <li><a href="/problems">PROBLEMS</a></li>
                    <li><a href="/login">ログイン</a></li>
                    <li><a href="/register">新規登録</a></li>
                </ul>
            </div>
        </nav>
        <script>
            document.addEventListener('DOMContentLoaded', () => {
                const toggle = document.querySelector('.nav-toggle');
                const menu = document.querySelector('.nav-menu');
                toggle.addEventListener('click', () => {
                    menu.classList.toggle('active');
                });
            });
        </script>
    `;
};

const wrapWithFlalign = (content) => {
    if (!content) return '';

    // 既に TeX の数式環境（例: \begin{align} など）が含まれている場合はそのまま返す
    if (content.includes('\\begin{') && content.includes('\\end{')) {
        return content;
    }

    // 末尾の余分な改行を削除
    content = content.trim();

    // 行ごとに分割（空行を除外）
    const lines = content.split(/\n/).filter(line => line.trim() !== '');
    let processedLines = [];

    for (let line of lines) {
        line = line.trim();
        if (!line) continue;

        // ディスプレイ数式 ($$...$$) を処理
        if (line.startsWith('$$') && line.endsWith('$$')) {
            // $$...$$ 内の内容を抽出
            const innerContent = line.slice(2, -2).trim();
            if (!innerContent) continue;

            // 数式と文章を分離して処理
            let processedLine = '';
            let i = 0;
            let inInlineMath = false;
            let buffer = '';

            while (i < innerContent.length) {
                const char = innerContent[i];

                // インライン数式 ($...$) の開始/終了を検出
                if (char === '$' && innerContent[i + 1] !== '$') {
                    if (!inInlineMath) {
                        // 数式の前の文章を処理（そのまま追加）
                        if (buffer.trim()) {
                            processedLine += buffer;
                            buffer = '';
                        }
                        inInlineMath = true;
                        buffer += char;
                    } else {
                        inInlineMath = false;
                        buffer += char;
                        // 数式部分をそのまま追加
                        processedLine += buffer;
                        buffer = '';
                    }
                }
                // TeX コマンド（例: \alpha など）を保持
                else if (char === '\\') {
                    let command = '\\';
                    i++;
                    while (i < innerContent.length && /[a-zA-Z{}]/.test(innerContent[i])) {
                        command += innerContent[i];
                        i++;
                    }
                    buffer += command;
                    i--; // ループで i++ されるので調整
                }
                // 通常の文字はバッファに追加
                else {
                    buffer += char;
                }
                i++;
            }

            // 最後のバッファを処理
            if (buffer) {
                processedLine += buffer;
            }

            // ディスプレイ数式として再構成（div でラップして行間を調整可能に）
            processedLines.push(`<div class="math-line">$$${processedLine.trim()}$$</div>`);
            continue;
        }

        // インライン数式 ($...$) を含む行を処理
        let processedLine = '';
        let i = 0;
        let inInlineMath = false;

        while (i < line.length) {
            const char = line[i];

            // インライン数式 ($...$) の開始/終了を検出
            if (char === '$' && line[i + 1] !== '$') {
                if (!inInlineMath) {
                    inInlineMath = true;
                    processedLine += char;
                } else {
                    inInlineMath = false;
                    processedLine += char;
                }
            }
            // TeX コマンド（例: \alpha など）を保持
            else if (char === '\\') {
                let command = '\\';
                i++;
                while (i < line.length && /[a-zA-Z{}]/.test(line[i])) {
                    command += line[i];
                    i++;
                }
                processedLine += command;
                i--; // ループで i++ されるので調整
            }
            // 通常の文字はそのまま追加
            else {
                processedLine += char;
            }
            i++;
        }

        // インライン数式を含む行全体を $$...$$ で囲む（ディスプレイ数式化）
        if (processedLine.includes('$')) {
            processedLine = `$$${processedLine}$$`;
        }
        // div でラップして行間を調整可能に
        processedLines.push(`<div class="math-line">${processedLine}</div>`);
    }

    // 行を結合（<br> を削除し、div のスタイルで調整）
    return processedLines.join('');
};

// HTMLページ生成関数
const generatePage = (nav, content, includeFooter = true) => `
    <!DOCTYPE html>
    <html lang="ja">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>TOHO Math Contest</title>
        <link rel="stylesheet" href="/style.css">
        <script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
        <style>
            .math-tex {
                text-align: left !important;
                display: block !important;
            }
            .MathJax {
                text-align: left !important;
            }
            .timer {
                font-size: 1.2em;
                color: #ff4500;
            }
            .modal {
                display: none;
                position: fixed;
                z-index: 1000;
                left: 0;
                top: 0;
                width: 100%;
                height: 100%;
                overflow: auto;
                background-color: rgba(0,0,0,0.8);
            }
            .modal-content {
                margin: 5% auto;
                padding: 20px;
                width: 90%;
                max-width: 800px;
                text-align: center;
            }
            .modal-content img {
                max-width: 100%;
                height: auto;
            }
            .close {
                color: #fff;
                font-size: 30px;
                font-weight: bold;
                position: absolute;
                top: 10px;
                right: 20px;
                cursor: pointer;
            }
            .close:hover,
            .close:focus {
                color: #ccc;
                text-decoration: none;
            }
        </style>
        <script>
            window.formatTime = function(seconds) {
                const hours = Math.floor(seconds / 3600);
                const minutes = Math.floor((seconds % 3600) / 60);
                const secs = seconds % 60;
                return \`\${hours}:\${minutes < 10 ? '0' : ''}\${minutes}:\${secs < 10 ? '0' : ''}\${secs}\`;
            };
            window.MathJax = {
                tex: {
                    inlineMath: [['$', '$'], ['\\(', '\\)']],
                    displayMath: [['$$', '$$'], ['\\[', '\\]']],
                    processEscapes: true,
                    packages: {'[+]': ['noerrors', 'noundefined', 'align', 'flalign']},
                    displayAlign: 'left'
                },
                loader: {load: ['[tex]/noerrors', '[tex]/noundefined', '[tex]/align', '[tex]/flalign']},
                startup: {
                    ready: () => {
                        MathJax.startup.defaultReady();
                        MathJax.startup.promise.then(() => {
                            MathJax.typesetPromise();
                        });
                    }
                }
            };
            function confirmDeletion(formId) {
                if (confirm('本当に削除しますか？')) {
                    document.getElementById(formId).submit();
                }
            }
            function showModal(imageSrc) {
                const modal = document.createElement('div');
                modal.className = 'modal';
                modal.innerHTML = \`
                    <span class="close" onclick="this.parentElement.style.display='none'">&times;</span>
                    <div class="modal-content">
                        <img src="\${imageSrc}" alt="Enlarged Image">
                    </div>
                \`;
                document.body.appendChild(modal);
                modal.style.display = 'block';
                modal.onclick = function(event) {
                    if (event.target === modal) {
                        modal.style.display = 'none';
                        document.body.removeChild(modal);
                    }
                };
            }
        </script>
    </head>
    <body>
        ${nav}
        <main>${content}</main>
        ${
            includeFooter
                ? '<footer><p>© 2025 TOHOMC. All rights reserved.</p></footer>'
                : ''
        }
    </body>
    </html>
`;

// ユーザー取得関数
const getUserFromCookie = async (req) => {
    try {
        const username = req.cookies.username;
        if (!username) return null;
        const users = await loadUsers();
        const user = users.find((u) => u.username === username) || null;
        return user;
    } catch (err) {
        console.error('getUserFromCookieエラー:', err);
        return null;
    }
};

// コンテスト管理権限のチェック関数
const canManageContest = (user, contest) => {
    if (!user || !user.username) return false;
    if (user.isAdmin) return true;
    const isManager = contest.managers && contest.managers.includes(user.username);
    const isWriter = contest.writers && contest.writers.includes(user.username);
    const isTester = contest.testers && contest.testers.includes(user.username);
    return isManager || isWriter || isTester;
};

// コンテストが終了していないかをチェックする関数
const isContestNotEnded = (contest) => {
    const now = DateTime.now().setZone('Asia/Tokyo');
    const end = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' });
    return now < end;
};

// コンテストが開始済みかをチェックする関数
const hasContestStarted = (contest) => {
    const now = DateTime.now().setZone('Asia/Tokyo');
    const start = DateTime.fromISO(contest.startTime, { zone: 'Asia/Tokyo' });
    return now >= start;
};

// コンテストが開催中かをチェックする関数
const isContestStartedOrActive = (contest) => {
    const now = DateTime.now().setZone('Asia/Tokyo');
    const start = DateTime.fromISO(contest.startTime, { zone: 'Asia/Tokyo' });
    const end = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' });
    return now >= start && now <= end;
};

// 問題ID生成関数
const generateProblemIds = (count) => {
    return Array.from({ length: count }, (_, i) => String.fromCharCode(65 + i));
};

// ルート：ホーム
app.get('/', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        const nav = generateNav(user);
        const content = `
            <section class="hero">
                <h2>数学の地力を上げよう！</h2>
                <p>TOHO Math Contestは、Online Math Contestのパロディサイトです。</p>
                <button onclick="window.location.href='/contests'">今すぐ参加</button>
            </section>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('ホームエラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：ログイン
app.get('/login', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (user) return res.redirect('/');
        const nav = generateNav(user);
        const content = `
            <section class="form-container">
                <h2>ログイン</h2>
                <form method="POST" action="/login">
                    <label>ユーザー名:</label><br>
                    <input type="text" name="username" placeholder="ユーザー名" required><br>
                    <label>パスワード:</label><br>
                    <input type="password" name="password" placeholder="パスワード" required><br>
                    <button type="submit">ログイン</button>
                </form>
            </section>
        `;
        res.send(generatePage(nav, content, false));
    } catch (err) {
        console.error('ログイン表示エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

app.post('/login', async (req, res) => {
    try {
        const users = await loadUsers();
        const { username, password } = req.body;
        const user = users.find((u) => u.username === username && u.password === password);
        if (user) {
            res.cookie('username', user.username, { httpOnly: true });
            return res.redirect(user.isAdmin ? '/admin' : '/contests');
        }
        res.send('ログイン失敗 <a href="/login">戻る</a>');
    } catch (err) {
        console.error('ログイン処理エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：ログアウト
app.get('/logout', (req, res) => {
    res.clearCookie('username');
    res.redirect('/');
});

// ルート：新規登録
app.get('/register', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (user) return res.redirect('/');
        const nav = generateNav(user);
        const content = `
            <section class="form-container">
                <h2>新規登録</h2>
                <form method="POST" action="/register">
                    <label>ユーザー名:</label><br>
                    <input type="text" name="username" placeholder="ユーザー名" required><br>
                    <label>パスワード:</label><br>
                    <input type="password" name="password" placeholder="パスワード" required><br>
                    <button type="submit">登録</button>
                </form>
            </section>
        `;
        res.send(generatePage(nav, content, false));
    } catch (err) {
        console.error('新規登録表示エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).send('ユーザー名とパスワードを入力してください');
        }

        const users = await loadUsers();
        if (users.some(user => user.username === username)) {
            return res.status(400).send('このユーザー名はすでに使用されています');
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        users.push({
            username,
            password: hashedPassword,
            rating: 100, // 初期ratingを100に設定
            contestHistory: [],
        });

        await saveUsers(users);
        res.redirect('/login');
    } catch (err) {
        console.error('登録エラー:', err);
        res.status(500).send('サーバーエラーが発生しました');
    }
});

// ルート：管理者ダッシュボード
// ルート：管理者ダッシュボード
app.get('/admin', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const nav = generateNav(user);
        const content = `
            <section class="hero">
                <h2>管理者ダッシュボード</h2>
                <form action="/admin/add-contest" method="GET">
                    <button type="submit">コンテストを追加</button>
                </form>
                <h3>管理可能なコンテスト</h3>
                <ul>
                    ${
                        contests
                            .filter(contest => canManageContest(user, contest)) // 管理者権限のあるコンテストのみ表示
                            .map((contest, index) => {
                                const start = DateTime.fromISO(contest.startTime, { zone: 'Asia/Tokyo' }).toFormat('M月d日 H:mm');
                                const end = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' }).toFormat('M月d日 H:mm');
                                const status = isContestStartedOrActive(contest) ? '開催中' : (isContestNotEnded(contest) ? '準備中' : '終了');
                                return `
                                    <li>
                                        ${contest.title} (開始: ${start}, 終了: ${end}, 状態: ${status})
                                        ${
                                            user.isAdmin // サイト管理者のみに削除ボタンを表示
                                            ? `<form id="delete-form-${index}" action="/admin/delete-contest" method="POST" style="display:inline;">
                                                <input type="hidden" name="index" value="${index}">
                                                <button type="button" onclick="confirmDeletion('delete-form-${index}')">削除</button>
                                            </form>`
                                            : ''
                                        }
                                        <a href="/admin/contest-details/${index}">詳細</a>
                                        <a href="/admin/edit-contest/${index}">編集</a>
                                    </li>
                                `;
                            })
                            .join('') || '<p>管理可能なコンテストがありません</p>'
                    }
                </ul>
                ${
                    user.isAdmin
                        ? `<h3>ユーザー管理</h3><a href="/admin/users">ユーザー管理ページへ</a>`
                        : ''
                }
            </section>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('/adminエラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：コンテスト追加（一般ユーザー対応）
app.get('/contests/add-contest', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login'); // ログイン必須だが管理者権限は不要
        const nav = generateNav(user);
        const content = `
            <section class="form-container">
                <h2>新しいコンテストの作成</h2>
                <form method="POST" action="/contests/add-contest">
                    <label>コンテスト名:</label><br>
                    <input type="text" name="title" placeholder="コンテスト名" required><br>
                    <label>説明:</label><br>
                    <textarea name="description" placeholder="コンテストの説明" required></textarea><br>
                    <label>開始時間:</label><br>
                    <input type="datetime-local" name="startTime" required><br>
                    <label>終了時間:</label><br>
                    <input type="datetime-local" name="endTime" required><br>
                    <label>問題数:</label><br>
                    <input type="number" name="problemCount" min="1" placeholder="問題数" required><br>
                    <label>1問題あたりの提出制限 (デフォルトは10):</label><br>
                    <select name="submissionLimit">
                        <option value="5">5</option>
                        <option value="10" selected>10</option>
                    </select><br>
                    <button type="submit">コンテストを作成</button>
                </form>
                <p><a href="/contests">コンテスト一覧に戻る</a></p>
            </section>
        `;
        res.send(generatePage(nav, content, false));
    } catch (err) {
        console.error('コンテスト追加表示エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

app.post('/contests/add-contest', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login'); // ログイン必須だが管理者権限は不要
        const { title, description, startTime, endTime, problemCount, submissionLimit } = req.body;
        const contests = await loadContests();
        const numProblems = parseInt(problemCount);
        const problemIds = generateProblemIds(numProblems);

        const jstStartTime = DateTime.fromISO(startTime, { zone: 'Asia/Tokyo' }).toISO();
        const jstEndTime = DateTime.fromISO(endTime, { zone: 'Asia/Tokyo' }).toISO();

        contests.push({
            title,
            description,
            startTime: jstStartTime,
            endTime: jstEndTime,
            createdBy: user.username,
            testers: [],
            writers: [],
            problems: problemIds.map((id) => ({
                id,
                score: 100,
                writer: '',
                content: '',
                correctAnswer: '',
                image: '',
                explanation: '',
            })),
            managers: [user.username], // 作成者を管理者として追加
            submissions: [],
            problemCount: numProblems,
            review: '',
            submissionLimit: parseInt(submissionLimit) || 10,
        });
        await saveContests(contests);
        res.redirect('/contests');
    } catch (err) {
        console.error('コンテスト追加処理エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// コンテスト一覧に「コンテスト作成」リンクを追加
app.get('/contests', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        const contests = await loadContests();
        const nav = generateNav(user);

        const activeContestsWithIndex = contests
            .map((contest, index) => ({ contest, originalIndex: index }))
            .filter(({ contest }) => isContestNotEnded(contest));

        const content = `
            <section class="hero">
                <h2>コンテスト一覧</h2>
                <p>参加可能なコンテストをチェック！</p>
                ${
                    user
                        ? '<p><a href="/contests/add-contest">新しいコンテストを作成</a></p>'
                        : ''
                }
                <ul class="contest-list">
                    ${
                        activeContestsWithIndex.length > 0
                            ? activeContestsWithIndex
                                .map(({ contest, originalIndex }) => {
                                    const start = DateTime.fromISO(contest.startTime, { zone: 'Asia/Tokyo' }).toFormat('M月d日 H:mm');
                                    const end = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' }).toFormat('M月d日 H:mm');
                                    const status = isContestStartedOrActive(contest) ? '開催中' : '準備中';
                                    return `
                                        <li>
                                            <h3>${contest.title}</h3>
                                            <p>${contest.description}</p>
                                            <p>開始: ${start}</p>
                                            <p>終了: ${end}</p>
                                            <p>状態: ${status}</p>
                                            <button onclick="window.location.href='/contest/${originalIndex}'" ${
                                                status === '準備中' ? 'disabled' : ''
                                            }>${status === '開催中' ? '参加' : '参加'}</button>
                                            ${
                                                canManageContest(user, contest)
                                                    ? `<a href="/admin/contest-details/${originalIndex}">管理</a>`
                                                    : ''
                                            }
                                        </li>
                                    `;
                                })
                                .join('')
                            : '<p>現在終了していないコンテストはありません。</p>'
                    }
                </ul>
            </section>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('コンテスト一覧エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

app.post('/admin/add-contest', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user || !user.isAdmin) return res.redirect('/login');
        const { title, description, startTime, endTime, problemCount, submissionLimit } = req.body;
        const contests = await loadContests();
        const numProblems = parseInt(problemCount);
        const problemIds = generateProblemIds(numProblems);

        const jstStartTime = DateTime.fromISO(startTime, { zone: 'Asia/Tokyo' }).toISO();
        const jstEndTime = DateTime.fromISO(endTime, { zone: 'Asia/Tokyo' }).toISO();

        contests.push({
            title,
            description,
            startTime: jstStartTime,
            endTime: jstEndTime,
            createdBy: user.username,
            testers: [],
            writers: [],
            problems: problemIds.map((id) => ({
                id,
                score: 100,
                writer: '',
                content: '',
                correctAnswer: '',
                image: '',
                explanation: '',
            })),
            managers: [user.username],
            submissions: [],
            problemCount: numProblems,
            review: '',
            submissionLimit: parseInt(submissionLimit) || 10,
        });
        await saveContests(contests);
        res.redirect('/admin');
    } catch (err) {
        console.error('コンテスト追加処理エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：コンテスト削除
// ルート：コンテスト削除
app.post('/admin/delete-contest', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user || !user.isAdmin) return res.redirect('/login'); // サイト管理者でない場合はログイン画面へ
        const { index } = req.body;
        const contests = await loadContests();
        const idx = parseInt(index);
        if (idx >= 0 && idx < contests.length) {
            // サイト管理者のみが削除可能（canManageContestのチェックを削除）
            contests.splice(idx, 1);
            await saveContests(contests);
        } else {
            return res.status(404).send('無効なコンテストIDです');
        }
        res.redirect('/admin');
    } catch (err) {
        console.error('コンテスト削除エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：コンテスト一覧
app.get('/contests', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        const contests = await loadContests();
        const nav = generateNav(user);

        const activeContestsWithIndex = contests
            .map((contest, index) => ({ contest, originalIndex: index }))
            .filter(({ contest }) => isContestNotEnded(contest));

        const content = `
            <section class="hero">
                <h2>コンテスト一覧</h2>
                <p>参加可能なコンテストをチェック！</p>
                <ul class="contest-list">
                    ${
                        activeContestsWithIndex.length > 0
                            ? activeContestsWithIndex
                                .map(({ contest, originalIndex }) => {
                                    const start = DateTime.fromISO(contest.startTime, { zone: 'Asia/Tokyo' }).toFormat('M月d日 H:mm');
                                    const end = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' }).toFormat('M月d日 H:mm');
                                    const status = isContestStartedOrActive(contest) ? '開催中' : '準備中';
                                    return `
                                        <li>
                                            <h3>${contest.title}</h3>
                                            <p>${contest.description}</p>
                                            <p>開始: ${start}</p>
                                            <p>終了: ${end}</p>
                                            <p>状態: ${status}</p>
                                            <button onclick="window.location.href='/contest/${originalIndex}'" ${
                                                status === '準備中' ? 'disabled' : ''
                                            }>${status === '開催中' ? '参加' : '参加'}</button>
                                            ${
                                                canManageContest(user, contest)
                                                    ? `<a href="/admin/contest-details/${originalIndex}">管理</a>`
                                                    : ''
                                            }
                                        </li>
                                    `;
                                })
                                .join('')
                            : '<p>現在終了していないコンテストはありません。</p>'
                    }
                </ul>
            </section>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('コンテスト一覧エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：コンテスト詳細（問題一覧ページ）
app.get('/contest/:contestId', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        const problemIds = generateProblemIds(contest.problemCount);
        const endTime = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' }).toJSDate().getTime();
        const startTime = DateTime.fromISO(contest.startTime, { zone: 'Asia/Tokyo' }).toLocaleString(DateTime.DATETIME_FULL);
        const endTimeFormatted = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' }).toLocaleString(DateTime.DATETIME_FULL);

        const submissionsDuringContest = (contest.submissions || []).filter(
            (sub) => new Date(sub.date).getTime() <= endTime,
        );
        const userSubmissionsDuringContestMap = new Map();
        submissionsDuringContest.forEach((sub) => {
            const key = `${sub.user}-${sub.problemId}`;
            const existingSub = userSubmissionsDuringContestMap.get(key);
            if (
                !existingSub ||
                (existingSub.result !== 'CA' && sub.result === 'CA') ||
                (existingSub.result !== 'CA' &&
                    sub.result !== 'CA' &&
                    new Date(sub.date).getTime() > new Date(existingSub.date).getTime())
            ) {
                userSubmissionsDuringContestMap.set(key, sub);
            }
        });
        const uniqueSubmissionsDuringContest = Array.from(
            userSubmissionsDuringContestMap.values(),
        );

        const userSubmissionsMap = new Map();
        (contest.submissions || []).forEach((sub) => {
            const key = `${sub.user}-${sub.problemId}`;
            const existingSub = userSubmissionsMap.get(key);
            if (
                !existingSub ||
                (existingSub.result !== 'CA' && sub.result === 'CA') ||
                (existingSub.result !== 'CA' &&
                    sub.result !== 'CA' &&
                    new Date(sub.date).getTime() > new Date(existingSub.date).getTime())
            ) {
                userSubmissionsMap.set(key, sub);
            }
        });

        const nav = generateNav(user);
        const content = `
            <section class="hero">
                <h2>${contest.title}</h2>
                <p>${contest.description}</p>
                <p>開始: ${startTime}</p>
                <p>終了: ${endTimeFormatted}</p>
                <p>終了までの残り時間: <span id="timer" class="timer">${
                    isContestNotEnded(contest) ? '' : 'Finished'
                }</span></p>
                ${
                    isContestNotEnded(contest)
                        ? `
                            <script>
                                const endTime = ${endTime};
                                function updateTimer() {
                                    const now = Date.now();
                                    const timeLeft = Math.max(0, Math.floor((endTime - now) / 1000));
                                    document.getElementById('timer').textContent = formatTime(timeLeft);
                                    if (timeLeft > 0) setTimeout(updateTimer, 1000);
                                }
                                updateTimer();
                            </script>
                        `
                        : ''
                }
                ${
                    !isContestNotEnded(contest) && contest.review
                        ? `<p><a href="/contest/${contestId}/review">講評を見る</a></p>`
                        : ''
                }
                <div class="tabs">
                    <a href="/contest/${contestId}" class="tab active">問題</a>
                    <a href="/contest/${contestId}/submissions" class="tab">提出一覧</a>
                    <a href="/contest/${contestId}/ranking" class="tab">ランキング</a>
                </div>
                <h3>問題一覧</h3>
                <table class="problem-table">
                    <tr>
                        <th>問題</th>
                        <th>ID</th>
                        <th>点数</th>
                        <th>正解者数/解答者数</th>
                        <th>Writer</th> <!-- 新しい列を追加 -->
                    </tr>
                    ${problemIds
                        .map((problemId) => {
                            const problem =
                                contest.problems.find((p) => p.id === problemId) || {
                                    score: 100,
                                };
                            const submissionsForProblemDuringContest =
                                uniqueSubmissionsDuringContest.filter(
                                    (sub) => sub.problemId === problemId,
                                );
                            const totalSubmittersDuringContest = new Set(
                                submissionsForProblemDuringContest.map((sub) => sub.user),
                            ).size;
                            const caSubmittersDuringContest = new Set(
                                submissionsForProblemDuringContest
                                    .filter((sub) => sub.result === 'CA')
                                    .map((sub) => sub.user),
                            ).size;

                            const userSubmission = userSubmissionsMap.get(
                                `${user.username}-${problemId}`,
                            );
                            const isCA = userSubmission && userSubmission.result === 'CA';

                            return `
                                <tr style="background-color: ${
                                    isCA ? '#90ee90' : 'white'
                                };">
                                    <td><a href="/contest/${contestId}/submit/${problemId}">問題 ${problemId}</a></td>
                                    <td>${problem.id}</td>
                                    <td>${problem.score || 100}</td>
                                    <td>${caSubmittersDuringContest} / ${totalSubmittersDuringContest}</td>
                                    <td>${problem.writer || '未設定'}</td> <!-- Writerを表示 -->
                                </tr>
                            `;
                        })
                        .join('')}
                </table>
                <p><a href="${
                    hasContestStarted(contest) ? '/contests' : '/problems'
                }">${
                    hasContestStarted(contest) ? 'コンテスト一覧' : 'PROBLEMSページ'
                }に戻る</a></p>
            </section>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('コンテスト詳細エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：コンテスト講評
app.get('/contest/:contestId/review', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (isContestNotEnded(contest)) {
            return res.status(403).send('コンテストが終了していないため講評は閲覧できません。');
        }

        const nav = generateNav(user);
        const content = `
            <section class="hero">
                <h2>${contest.title} - 講評</h2>
                <p>${contest.review.replace(/\n/g, '<br>') || '講評がまだ書かれていません。'}</p>
                <p><a href="/contest/${contestId}">コンテストに戻る</a></p>
            </section>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('コンテスト講評エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：提出一覧
app.get('/contest/:contestId/submissions', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const users = await loadUsers();
        const contestId = parseInt(req.params.contestId);

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        const submissions = contest.submissions || [];
        submissions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        const nav = generateNav(user);
        const content = `
            <section class="hero">
                <h2>${contest.title} - 提出一覧</h2>
                <div class="tabs">
                    <a href="/contest/${contestId}" class="tab">問題</a>
                    <a href="/contest/${contestId}/submissions" class="tab active">提出一覧</a>
                    <a href="/contest/${contestId}/ranking" class="tab">ランキング</a>
                </div>
                <table class="submission-table">
                    <thead>
                        <tr>
                            <th>提出日時</th>
                            <th>ユーザー</th>
                            <th>問題</th>
                            <th>結果</th>
                            <th>詳細</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${
                            submissions.length > 0
                                ? submissions
                                      .map((sub) => {
                                          const date = DateTime.fromISO(sub.date, { zone: 'Asia/Tokyo' }).toFormat('yyyy/MM/dd HH:mm:ss');
                                          const targetUser = users.find(u => u.username === sub.user);
                                          const ratingColor = getRatingColor(targetUser ? (targetUser.rating || 0) : 0);
                                          return `
                                              <tr>
                                                  <td>${date}</td>
                                                  <td style="color: ${ratingColor};">${sub.user}</td>
                                                  <td>${sub.problemId}</td>
                                                  <td class="${sub.result === 'CA' ? 'ca' : 'wa'}">${sub.result}</td>
                                                  <td><a href="/submission/${contestId}/${submissions.indexOf(sub)}">詳細</a></td>
                                              </tr>
                                          `;
                                      })
                                      .join('')
                                : '<tr><td colspan="5">提出がありません</td></tr>'
                        }
                    </tbody>
                </table>
                <p><a href="${hasContestStarted(contest) ? '/contests' : '/problems'}">${hasContestStarted(contest) ? 'コンテスト一覧' : 'PROBLEMSページ'}に戻る</a></p>
            </section>
            <style>
                .submission-table {
                    width: 100%;
                    border-collapse: collapse;
                    margin: 20px 0;
                }
                .submission-table th, .submission-table td {
                    padding: 10px;
                    text-align: center;
                    border: 1px solid #ddd;
                }
                .submission-table th {
                    background-color: #f2f2f2;
                }
                .submission-table .ca {
                    color: green;
                    font-weight: bold;
                }
                .submission-table .wa {
                    color: red;
                }
                .submission-table a {
                    color: #007bff;
                    text-decoration: none;
                }
                .submission-table a:hover {
                    text-decoration: underline;
                }
            </style>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('提出一覧エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：ランキング
// ルート：ランキング
app.get('/contest/:contestId/ranking', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const users = await loadUsers();
        const contestId = parseInt(req.params.contestId);

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        const endTime = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' }).toJSDate().getTime();

        const submissionsDuringContest = (contest.submissions || []).filter(
            (sub) => new Date(sub.date).getTime() <= endTime,
        );

        const userSubmissionsDuringContestMap = new Map();
        submissionsDuringContest.forEach((sub) => {
            const key = `${contestId}-${sub.user}-${sub.problemId}`;
            const existingSub = userSubmissionsDuringContestMap.get(key);
            if (
                !existingSub ||
                (existingSub.result !== 'CA' && sub.result === 'CA') ||
                (existingSub.result !== 'CA' &&
                    sub.result !== 'CA' &&
                    new Date(sub.date).getTime() > new Date(existingSub.date).getTime())
            ) {
                userSubmissionsDuringContestMap.set(key, sub);
            }
        });
        const uniqueSubmissionsDuringContest = Array.from(
            userSubmissionsDuringContestMap.values(),
        );

        const problemIds = generateProblemIds(contest.problemCount);
        const problemScores = {};
        (contest.problems || []).forEach((problem) => {
            problemScores[problem.id] = problem.score || 100;
        });

        // 各問題のdifficultyを計算
        contest.problems.forEach(problem => {
            problem.difficulty = calculateDifficulty(contest, problem.id, users);
        });

        const userStats = {};
        const startTime = DateTime.fromISO(contest.startTime, { zone: 'Asia/Tokyo' }).toJSDate().getTime();
        const firstFA = {};

        submissionsDuringContest.sort(
            (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
        );

        submissionsDuringContest.forEach((sub) => {
            const username = sub.user;
            const problemId = sub.problemId;
            const result = sub.result;
            const submissionTime = new Date(sub.date).getTime();
            const timeSinceStart = (submissionTime - startTime) / 1000;

            if (!userStats[username]) {
                userStats[username] = {
                    score: 0,
                    lastCATime: 0,
                    problems: {},
                    totalWABeforeCA: 0,
                };
            }

            if (!userStats[username].problems[problemId]) {
                userStats[username].problems[problemId] = {
                    status: 'none',
                    time: null,
                    waCountBeforeCA: 0,
                    waCount: 0,
                };
            }

            const problemStat = userStats[username].problems[problemId];

            if (result === 'CA' && problemStat.status !== 'CA') {
                problemStat.status = 'CA';
                problemStat.time = timeSinceStart;
                userStats[username].score += problemScores[problemId] || 0;
                userStats[username].lastCATime = Math.max(
                    userStats[username].lastCATime,
                    timeSinceStart,
                );

                if (!firstFA[problemId] || submissionTime < firstFA[problemId].time) {
                    firstFA[problemId] = { user: username, time: submissionTime };
                }
            } else if (result === 'WA' && problemStat.status !== 'CA') {
                problemStat.waCountBeforeCA += 1;
                problemStat.waCount += 1;
                problemStat.status = 'WA';
            } else if (result === 'WA') {
                problemStat.waCount += 1;
            }
        });

        Object.keys(userStats).forEach((username) => {
            userStats[username].totalWABeforeCA = Object.values(
                userStats[username].problems,
            ).reduce((sum, p) => sum + (p.status === 'CA' ? p.waCountBeforeCA : 0), 0);
        });

        const rankings = Object.keys(userStats).map((username) => {
            const stats = userStats[username];
            const penaltyTime = stats.totalWABeforeCA * 300;
            return {
                username,
                score: stats.score,
                lastCATime: stats.lastCATime + penaltyTime,
                problems: stats.problems,
                totalWABeforeCA: stats.totalWABeforeCA,
            };
        });

        rankings.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.lastCATime - b.lastCATime;
        });

        // Performanceとratingの計算（コンテストが終了している場合のみ）
        if (!isContestNotEnded(contest)) {
            const userPerformances = {};
            rankings.forEach((rank, index) => {
                const rankPosition = index + 1;
                const performance = calculatePerformance(contest, rank.username, rankPosition, contests);
                userPerformances[rank.username] = performance;
            });
    
            for (const [username, performance] of Object.entries(userPerformances)) {
                const targetUser = users.find(u => u.username === username);
                if (targetUser) {
                    const existingHistory = targetUser.contestHistory.find(h => h.contestId === contestId);
                    if (!existingHistory) {
                        const newRating = updateUserRating(targetUser, performance);
                        targetUser.contestHistory.push({
                            contestId,
                            contestTitle: contest.title,
                            rank: rankings.findIndex(r => r.username === username) + 1,
                            performance,
                            ratingAfterContest: newRating,
                            endTime: contest.endTime,
                        });
                    }
                }
            }
            await saveUsers(users);
    
            contest.userPerformances = Object.entries(userPerformances).map(([username, performance]) => ({
                username,
                performance,
            }));
            await saveContests(contests);
        }

        const nav = generateNav(user);
        const content = `
            <section class="hero">
                <h2>${contest.title} - ランキング</h2>
                <div class="tabs">
                    <a href="/contest/${contestId}" class="tab">問題</a>
                    <a href="/contest/${contestId}/submissions" class="tab">提出一覧</a>
                    <a href="/contest/${contestId}/ranking" class="tab active">ランキング</a>
                </div>
                <div class="table-wrapper">
                    <table class="ranking-table" id="rankingTable">
                        <thead>
                            <tr>
                                <th class="fixed-col">#</th>
                                <th>User</th>
                                <th>Score</th>
                                <th>Last CA Time<br>Total WA</th>
                                ${problemIds
                                    .map(
                                        (id) => `
                                            <th>${id}<br>${problemScores[id] || 100}<br>
                                            <span class="first-fa" data-problem-id="${id}"></span>
                                            </th>
                                        `,
                                    )
                                    .join('')}
                            </tr>
                        </thead>
                        <tbody>
    ${rankings
        .map((rank, index) => {
            const isCurrentUser = rank.username === user.username;
            const targetUser = users.find(u => u.username === rank.username);
            const ratingColor = getRatingColor(targetUser ? (targetUser.rating || 0) : 0);
            return `
                <tr class="ranking-row" data-index="${index}">
                    <td class="fixed-col">${index + 1}</td>
                    <td style="color: ${ratingColor}; ${isCurrentUser ? 'font-weight: bold;' : ''}">${rank.username}</td>
                    <td>${rank.score}</td>
                    <td class="last-ca-time" data-time="${Math.floor(rank.lastCATime)}">${rank.totalWABeforeCA}</td>
                    ${problemIds
                        .map((problemId) => {
                            const problem = rank.problems[problemId] || { status: 'none', waCount: 0, time: null };
                            if (problem.status === 'CA') {
                                return `<td style="background-color: #90ee90;" class="problem-time" data-time="${Math.floor(problem.time) || 0}">${problem.waCount}</td>`;
                            } else if (problem.status === 'WA') {
                                return `<td style="background-color: #ffcccc;">+${problem.waCount}</td>`;
                            } else {
                                return `<td>-</td>`;
                            }
                        })
                        .join('')}
                </tr>
            `;
        })
        .join('') || '<tr><td colspan="' + (4 + problemIds.length) + '">ランキングがありません</td></tr>'}
</tbody>
                    </table>
                </div>
                <p><a href="${hasContestStarted(contest) ? '/contests' : '/problems'}">${hasContestStarted(contest) ? 'コンテスト一覧' : 'PROBLEMSページ'}に戻る</a></p>
            </section>
            <style>
                .table-wrapper {
                    overflow-x: auto;
                    -webkit-overflow-scrolling: touch;
                    max-width: 100%;
                }
                .ranking-table {
                    width: auto; /* 幅をコンテンツに応じて自動調整 */
                    border-collapse: collapse;
                }
                .ranking-table th, .ranking-table td {
                    padding: 8px;
                    text-align: center;
                    border: 1px solid #ddd;
                    white-space: nowrap;
                    min-width: 20px; /* 各列の最小幅を設定 */
                }
                .fixed-col {
                    position: sticky;
                    left: 0;
                    background-color: #f8f8f8;
                    z-index: 1;
                    min-width: 40px; /* #列は狭めに */
                }
                @media (max-width: 768px) {
                    .ranking-table th, .ranking-table td {
                        font-size: 0.85em;
                        padding: 6px;
                    }
                }
            </style>
            <script>
                document.addEventListener('DOMContentLoaded', function() {
                    function formatTime(seconds) {
                        const hours = Math.floor(seconds / 3600);
                        const minutes = Math.floor((seconds % 3600) / 60);
                        const secs = seconds % 60;
                        return \`\${hours}:\${minutes < 10 ? '0' : ''}\${minutes}:\${secs < 10 ? '0' : ''}\${secs}\`;
                    }

                    const firstFA = ${JSON.stringify(firstFA)};
                    const startTime = ${startTime};
                    document.querySelectorAll('.first-fa').forEach(cell => {
                        const problemId = cell.getAttribute('data-problem-id');
                        if (firstFA[problemId]) {
                            const faTime = Math.floor((firstFA[problemId].time - startTime) / 1000);
                            cell.innerHTML = \`FA: \${firstFA[problemId].user}<br>\${formatTime(faTime)}\`;
                        } else {
                            cell.innerHTML = 'CA者なし';
                        }
                    });

                    document.querySelectorAll('.ranking-row').forEach(row => {
                        const lastCaCell = row.querySelector('.last-ca-time');
                        const lastCaTime = parseInt(lastCaCell.getAttribute('data-time'));
                        lastCaCell.innerHTML = formatTime(lastCaTime) + '<br>+' + lastCaCell.textContent;

                        row.querySelectorAll('.problem-time').forEach(cell => {
                            const time = parseInt(cell.getAttribute('data-time'));
                            cell.innerHTML = formatTime(time) + '<br>+' + cell.textContent;
                        });
                    });
                });
            </script>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('ランキングエラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：マイページ
// ルート：マイページ
app.get('/mypage', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const nav = generateNav(user);

        // コンテスト履歴を終了時間でソート（新しい順）
        const sortedHistory = user.contestHistory.sort((a, b) => {
            return DateTime.fromISO(b.endTime).toJSDate().getTime() - DateTime.fromISO(a.endTime).toJSDate().getTime();
        });

        const content = `
            <section class="hero">
                <h2>マイページ</h2>
                <div class="rating-display">
                    <h3>現在のRating: <span class="rating-value">${user.rating || 100}</span></h3>
                </div>
                <h3>コンテスト履歴</h3>
                <div class="table-wrapper">
                    <table class="history-table">
                        <thead>
                            <tr>
                                <th>コンテスト</th>
                                <th>順位</th>
                                <th>Performance</th>
                                <th>終了時点のRating</th>
                                <th>終了日時</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${
                                sortedHistory.length > 0
                                    ? sortedHistory.map(history => {
                                          const endTime = DateTime.fromISO(history.endTime, { zone: 'Asia/Tokyo' }).toFormat('yyyy/MM/dd HH:mm');
                                          return `
                                              <tr>
                                                  <td><a href="/contest/${history.contestId}">${history.contestTitle}</a></td>
                                                  <td>${history.rank}</td>
                                                  <td>${history.performance}</td>
                                                  <td>${history.ratingAfterContest}</td>
                                                  <td>${endTime}</td>
                                              </tr>
                                          `;
                                      }).join('')
                                    : '<tr><td colspan="5">コンテスト履歴がありません</td></tr>'
                            }
                        </tbody>
                    </table>
                </div>
                <p><a href="/">ホームに戻る</a></p>
            </section>
            <style>
                .rating-display {
                    margin: 20px 0;
                    padding: 20px;
                    background-color: #f0f8ff;
                    border-radius: 8px;
                    text-align: center;
                }
                .rating-value {
                    font-size: 2em;
                    font-weight: bold;
                    color: #2e8b57;
                }
                .table-wrapper {
                    overflow-x: auto;
                    -webkit-overflow-scrolling: touch;
                    max-width: 100%;
                }
                .history-table {
                    width: 100%;
                    border-collapse: collapse;
                    margin: 20px 0;
                }
                .history-table th, .history-table td {
                    padding: 10px;
                    text-align: center;
                    border: 1px solid #ddd;
                }
                .history-table th {
                    background-color: #f2f2f2;
                }
                .history-table a {
                    color: #007bff;
                    text-decoration: none;
                }
                .history-table a:hover {
                    text-decoration: underline;
                }
                @media (max-width: 768px) {
                    .history-table th, .history-table td {
                        font-size: 0.9em;
                        padding: 6px;
                    }
                }
            </style>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('マイページエラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：問題提出ページ
app.get('/contest/:contestId/submit/:problemId', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);
        const problemId = req.params.problemId;

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        const problem = contest.problems.find((p) => p.id === problemId);
        if (!problem) {
            return res.status(404).send('無効な問題IDです');
        }

        const endTime = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' }).toJSDate().getTime();

        let displayContent = problem.content || '未設定';
        displayContent = displayContent.replace(/\n(?![ \t]*\$)/g, '<br>');
        displayContent = wrapWithFlalign(displayContent);
    
        const nav = generateNav(user);
        let content = `
    <section class="hero">
        <h2>${contest.title} - 問題 ${problemId}</h2>
        <p>終了までの残り時間: <span id="timer" class="timer">${
            isContestNotEnded(contest) ? '' : '終了済み'
        }</span></p>
        ${
            isContestNotEnded(contest)
                ? `
                    <script>
                        const endTime = ${endTime};
                        function updateTimer() {
                            const now = Date.now();
                            const timeLeft = Math.max(0, Math.floor((endTime - now) / 1000));
                            document.getElementById('timer').textContent = formatTime(timeLeft);
                            if (timeLeft > 0) setTimeout(updateTimer, 1000);
                        }
                        updateTimer();
                    </script>
                `
                : ''
        }
        <div class="problem-display">
            <p>配点: ${problem.score || 100}点</p>
            <p>内容: <span class="math-tex">${displayContent}</span></p>
            <p>作成者: ${problem.writer || '未設定'}</p>
            ${
                problem.image
                    ? `<p>画像: <img src="${problem.image}" alt="Problem Image" style="max-width: 300px; cursor: pointer;" onclick="showModal('${problem.image.replace(/'/g, "\\'")}')"></p>`
                    : ''
            }
        </div>
        <div class="calculator">
            <h3>簡易電卓</h3>
            <div class="calc-display">
                <input type="text" id="calcInput" value="0" readonly>
            </div>
            <div class="calc-buttons">
                <button onclick="clearCalc()">AC</button>
                <button onclick="clearEntry()">C</button>
                <button onclick="squareRoot()">√</button>
                <button onclick="appendToCalc('/')">÷</button>

                <button onclick="appendToCalc('7')">7</button>
                <button onclick="appendToCalc('8')">8</button>
                <button onclick="appendToCalc('9')">9</button>
                <button onclick="appendToCalc('*')">×</button>

                <button onclick="appendToCalc('4')">4</button>
                <button onclick="appendToCalc('5')">5</button>
                <button onclick="appendToCalc('6')">6</button>
                <button onclick="appendToCalc('-')">-</button>

                <button onclick="appendToCalc('1')">1</button>
                <button onclick="appendToCalc('2')">2</button>
                <button onclick="appendToCalc('3')">3</button>
                <button onclick="appendToCalc('+')">+</button>

                <button onclick="square()">X²</button>
                <button onclick="cube()">X³</button>
                <button onclick="appendToCalc('0')">0</button>
                <button onclick="appendToCalc('.')">.</button>

                <button onclick="memoryClear()">MC</button>
                <button onclick="memoryRecall()">MR</button>
                <button onclick="memorySubtract()">M-</button>
                <button onclick="memoryAdd()">M+</button>

                <button onclick="calculate()">=</button>
            </div>
        </div>
        <style>
            .calculator {
                margin: 20px 0;
                padding: 10px;
                border: 1px solid #ccc;
                border-radius: 5px;
                width: 250px;
                background-color: #f9f9f9;
            }
            .calc-display {
                margin-bottom: 10px;
            }
            #calcInput {
                width: 100%;
                padding: 5px;
                font-size: 1.2em;
                text-align: right;
                border: 1px solid #ccc;
                border-radius: 3px;
            }
            .calc-buttons {
                display: grid;
                grid-template-columns: repeat(4, 1fr);
                gap: 5px;
            }
            .calc-buttons button {
                padding: 10px;
                font-size: 1em;
                border: 1px solid #ccc;
                border-radius: 3px;
                background-color: #fff;
                cursor: pointer;
            }
            .calc-buttons button:hover {
                background-color: #e0e0e0;
            }
        </style>
        <script>
            let currentInput = '0';
            let memory = 0;

            function appendToCalc(value) {
                if (currentInput === '0' && value !== '.') {
                    currentInput = value;
                } else {
                    currentInput += value;
                }
                document.getElementById('calcInput').value = currentInput;
            }

            function clearCalc() {
                currentInput = '0';
                memory = 0;
                document.getElementById('calcInput').value = currentInput;
            }

            function clearEntry() {
                currentInput = '0';
                document.getElementById('calcInput').value = currentInput;
            }

            function memoryClear() {
                memory = 0;
            }

            function memoryRecall() {
                currentInput = memory.toString();
                document.getElementById('calcInput').value = currentInput;
            }

            function memorySubtract() {
                memory -= parseFloat(currentInput) || 0;
            }

            function memoryAdd() {
                memory += parseFloat(currentInput) || 0;
            }

            function square() {
                try {
                    const num = parseFloat(currentInput);
                    currentInput = Math.pow(num, 2).toString();
                    document.getElementById('calcInput').value = currentInput;
                } catch (e) {
                    document.getElementById('calcInput').value = 'Error';
                    currentInput = '0';
                }
            }

            function cube() {
                try {
                    const num = parseFloat(currentInput);
                    currentInput = Math.pow(num, 3).toString();
                    document.getElementById('calcInput').value = currentInput;
                } catch (e) {
                    document.getElementById('calcInput').value = 'Error';
                    currentInput = '0';
                }
            }

            function squareRoot() {
                try {
                    const num = parseFloat(currentInput);
                    if (num < 0) {
                        document.getElementById('calcInput').value = 'Error (負の数)';
                        currentInput = '0';
                    } else {
                        currentInput = Math.sqrt(num).toString();
                        document.getElementById('calcInput').value = currentInput;
                    }
                } catch (e) {
                    document.getElementById('calcInput').value = 'Error';
                    currentInput = '0';
                }
            }

            function calculate() {
                try {
                    currentInput = eval(currentInput).toString();
                    document.getElementById('calcInput').value = currentInput;
                } catch (e) {
                    document.getElementById('calcInput').value = 'Error';
                    currentInput = '0';
                }
            }
        </script>
`;

if (!isContestNotEnded(contest) && problem.explanation) {
    content += `<p><a href="/contest/${contestId}/explanation/${problemId}">解答解説を見る</a></p>`;
}

if (isContestStartedOrActive(contest) && canManageContest(user, contest)) {
    content += `
        <p style="color: red;">あなたはこのコンテストの管理者権限を持っているため、開催中に問題に回答することはできません。</p>
    `;
} else {
    content += `
        <form method="POST" action="/contest/${contestId}/submit/${problemId}" onsubmit="return validateAnswer()">
            <label>解答 (半角数字のみ):</label><br>
            <input type="number" name="answer" placeholder="解答を入力" required><br>
            <button type="submit">提出</button>
        </form>
        ${
            !isContestStartedOrActive(contest)
                ? '<p style="color: orange;">このコンテストは未開始または終了しています。提出は可能ですが、ランキングには反映されません。</p>'
                : ''
        }
        <script>
            function validateAnswer() {
                const answer = document.querySelector('input[name="answer"]').value;
                const regex = /^[0-9]+$/;
                if (!regex.test(answer)) {
                    alert('解答は半角数字のみで入力してください。');
                    return false;
                }
                return true;
            }
        </script>
    `;
}

content += `
    <p><a href="${
        hasContestStarted(contest) ? '/contest/' + contestId : '/problems'
    }">${
        hasContestStarted(contest) ? '問題一覧' : 'PROBLEMSページ'
    }に戻る</a></p>
    </section>
`;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('問題提出ページエラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：問題解説
app.get('/contest/:contestId/explanation/:problemId', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);
        const problemId = req.params.problemId;

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (isContestNotEnded(contest)) {
            return res.status(403).send('コンテストが終了していないため解説は閲覧できません。');
        }

        const problem = contest.problems.find((p) => p.id === problemId);
        if (!problem) {
            return res.status(404).send('無効な問題IDです');
        }

        let displayExplanation = problem.explanation || '未設定';
        displayExplanation = displayExplanation.replace(/\n(?![ \t]*\$)/g, '<br>');
        displayExplanation = wrapWithFlalign(displayExplanation);

        const nav = generateNav(user);
        const content = `
            <section class="hero">
                <h2>${contest.title} - 問題 ${problemId} 解答解説</h2>
                <div class="problem-display">
                    <p>解説: <span class="math-tex">${displayExplanation}</span></p>
                    ${
                        problem.explanationImage 
                            ? `<p>解説画像: <img src="${problem.explanationImage}" alt="Explanation Image" style="max-width: 300px; cursor: pointer;" onclick="showModal('${problem.explanationImage.replace(/'/g, "\\'")}')"></p>`
                            : '<p>解説画像: 未設定</p>'
                    }
                </div>
                <p><a href="/contest/${contestId}/submit/${problemId}">問題に戻る</a></p>
            </section>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('問題解説エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：問題提出処理
app.post('/contest/:contestId/submit/:problemId', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);
        const problemId = req.params.problemId;

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (isContestStartedOrActive(contest) && canManageContest(user, contest)) {
            return res.status(403).send('あなたはこのコンテストの管理者権限を持っているため、開催中に問題に回答することはできません。');
        }

        const problem = contest.problems.find((p) => p.id === problemId);
        if (!problem) {
            return res.status(404).send('無効な問題IDです');
        }

        const endTime = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' }).toJSDate().getTime();
        const submissionLimit = contest.submissionLimit || 10;
        const submissionsDuringContest = (contest.submissions || [])
            .filter(
                (sub) =>
                    sub.user === user.username &&
                    sub.problemId === problemId &&
                    new Date(sub.date).getTime() <= endTime,
            );
        if (isContestStartedOrActive(contest) && submissionsDuringContest.length >= submissionLimit) {
            return res.status(403).send(`コンテスト中にこの問題に提出できるのは${submissionLimit}回までです。`);
        }

        const submittedAnswer = req.body.answer.trim();
        const regex = /^[0-9]+$/;
        if (!regex.test(submittedAnswer)) {
            return res.status(400).send('解答は半角数字のみで入力してください。');
        }

        const correctAnswer = problem.correctAnswer ? problem.correctAnswer.toString().trim() : null;
        const result = correctAnswer ? (submittedAnswer === correctAnswer ? 'CA' : 'WA') : '未判定';

        const submission = {
            contestId: contestId,
            date: DateTime.now().setZone('Asia/Tokyo').toISO(),
            problemId: problemId,
            user: user.username,
            result: result,
            answer: submittedAnswer,
        };
        if (!contest.submissions) contest.submissions = [];
        contest.submissions.push(submission);

        await saveContests(contests);
        res.redirect(`/contest/${contestId}/submissions`);
    } catch (err) {
        console.error('問題提出処理エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：過去の問題
app.get('/problems', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const users = await loadUsers(); // ユーザーデータを取得してdifficulty計算に使用
        const nav = generateNav(user);
        const endedContests = contests.filter((contest) => !isContestNotEnded(contest));

        // すべてのコンテストの中で最大の問題数を求める
        const maxProblemCount = Math.max(...endedContests.map(contest => contest.problemCount || 0), 0);
        const problemIds = generateProblemIds(maxProblemCount); // 最大問題数に基づいて問題IDを生成

        // 各問題のdifficultyを計算
        endedContests.forEach(contest => {
            contest.problems.forEach(problem => {
                problem.difficulty = calculateDifficulty(contest, problem.id, users);
            });
        });

        const content = `
            <section class="hero">
                <h2>終了したコンテストの問題</h2>
                <p>過去のコンテストの問題を閲覧できます。</p>
                <div class="contest-table-container">
                    <table class="contest-table">
                        <thead>
                            <tr>
                                <th class="fixed-col">コンテスト</th>
                                ${problemIds.map(id => `<th>${id}</th>`).join('')}
                            </tr>
                        </thead>
                        <tbody>
                            ${
                                endedContests
                                    .map((contest) => {
                                        const start = DateTime.fromISO(contest.startTime, { zone: 'Asia/Tokyo' }).toFormat('M月d日 H:mm');
                                        const end = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' }).toFormat('M月d日 H:mm');
                                        const contestProblemIds = generateProblemIds(contest.problemCount);

                                        return `
                                            <tr>
                                                <td class="fixed-col contest-title">
                                                    <h3>${contest.title}</h3>
                                                    <p>${contest.description}</p>
                                                    <p>開始: ${start}</p>
                                                    <p>終了: ${end}</p>
                                                    <p>
                                                        <a href="/contest/${contests.indexOf(contest)}">問題</a> |
                                                        <a href="/contest/${contests.indexOf(contest)}/submissions">提出一覧</a> |
                                                        <a href="/contest/${contests.indexOf(contest)}/ranking">ランキング</a> |
                                                        <a href="/contest/${contests.indexOf(contest)}/explanations">解答解説</a> |
                                                        <a href="/contest/${contests.indexOf(contest)}/review">講評</a>
                                                    </p>
                                                </td>
                                                ${problemIds
                                                    .map((problemId) => {
                                                        if (!contestProblemIds.includes(problemId)) {
                                                            return `<td>-</td>`; // 問題が存在しない場合は「-」を表示
                                                        }
                                                        const problem = contest.problems.find((p) => p.id === problemId);
                                                        if (!problem) {
                                                            return `<td>-</td>`;
                                                        }
                                                        const userSubmissions = (contest.submissions || []).filter(
                                                            (sub) =>
                                                                sub.user === user.username &&
                                                                sub.problemId === problemId,
                                                        );
                                                        const isCA = userSubmissions.some((sub) => sub.result === 'CA');
                                                        return `
                                                            <td style="background-color: ${isCA ? '#90ee90' : 'white'}; position: relative;">
                                                                <span class="difficulty-circle" onclick="showDifficulty(${problem.difficulty})">○</span>
                                                                <a href="/contest/${contests.indexOf(contest)}/submit/${problem.id}">
                                                                    ${problem.id}
                                                                </a>
                                                            </td>
                                                        `;
                                                    })
                                                    .join('')}
                                            </tr>
                                        `;
                                    })
                                    .join('') || '<tr><td colspan="' + (maxProblemCount + 1) + '">終了したコンテストはありません。</td></tr>'
                            }
                        </tbody>
                    </table>
                </div>
                <p><a href="/">ホームに戻る</a></p>
            </section>
            <style>
                .contest-table-container {
                    overflow-x: auto;
                    overflow-y: auto;
                    -webkit-overflow-scrolling: touch;
                    max-width: 100%;
                    max-height: 600px; /* 縦スクロール用の高さ制限 */
                }
                .contest-table {
                    width: auto;
                    border-collapse: collapse;
                    margin: 20px 0;
                }
                .contest-table th, .contest-table td {
                    border: 1px solid #ddd;
                    padding: 8px;
                    text-align: center;
                    vertical-align: middle;
                    min-width: 50px;
                }
                .contest-table th {
                    background-color: #f2f2f2;
                    position: sticky;
                    top: 0;
                    z-index: 2;
                }
                .contest-table .fixed-col {
                    position: sticky;
                    left: 0;
                    background-color: #f8f8f8;
                    z-index: 1;
                    min-width: 300px;
                    text-align: left;
                }
                .contest-table a {
                    color: #007bff;
                    text-decoration: none;
                }
                .contest-table a:hover {
                    text-decoration: underline;
                }
                .difficulty-circle {
                    position: absolute;
                    left: 5px;
                    top: 50%;
                    transform: translateY(-50%);
                    width: 20px;
                    height: 20px;
                    border-radius: 50%;
                    background-color: #d3e8d3;
                    color: #333;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    font-size: 12px;
                }
                @media (max-width: 768px) {
                    .contest-table th, .contest-table td {
                        font-size: 0.9em;
                        padding: 6px;
                    }
                    .contest-table .fixed-col {
                        min-width: 200px;
                    }
                    .difficulty-circle {
                        width: 16px;
                        height: 16px;
                        font-size: 10px;
                    }
                }
            </style>
            <script>
                function showDifficulty(difficulty) {
                    alert('Difficulty: ' + difficulty);
                }
            </script>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('過去の問題エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：全問題の解答解説ページ
app.get('/contest/:contestId/explanations', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (isContestNotEnded(contest)) {
            return res.status(403).send('コンテストが終了していないため解説は閲覧できません。');
        }

        const nav = generateNav(user);
        const content = `
            <section class="hero">
                <h2>${contest.title} - 全問題の解答解説</h2>
                <div class="explanations">
                    ${
                        contest.problems
                            .map((problem) => {
                                let displayExplanation = problem.explanation || '未設定';
                                displayExplanation = displayExplanation.replace(/\n(?![ \t]*\$)/g, '<br>');
                                displayExplanation = wrapWithFlalign(displayExplanation);

                                return `
                                    <div class="explanation-item">
                                        <h3>問題 ${problem.id}</h3>
                                        <p>解説: <span class="math-tex">${displayExplanation}</span></p>
                                        ${
                                            problem.explanationImage
                                                ? `<p>解説画像: <img src="${problem.explanationImage}" alt="Explanation Image" style="max-width: 300px; cursor: pointer;" onclick="showModal('${problem.explanationImage.replace(/'/g, "\\'")}')"></p>`
                                                : '<p>解説画像: 未設定</p>'
                                        }
                                        <p><a href="/contest/${contestId}/submit/${problem.id}">問題ページへ</a></p>
                                    </div>
                                `;
                            })
                            .join('') || '<p>問題がありません。</p>'
                    }
                </div>
                <p><a href="/contest/${contestId}">コンテストに戻る</a></p>
            </section>
            <style>
                .explanations {
                    margin-top: 20px;
                }
                .explanation-item {
                    border-bottom: 1px solid #ddd;
                    padding: 20px 0;
                }
                .explanation-item:last-child {
                    border-bottom: none;
                }
                .explanation-item h3 {
                    margin-top: 0;
                    color: #333;
                }
            </style>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('全問題解説エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：コンテスト詳細（管理者）
app.get('/admin/contest-details/:contestId', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (!canManageContest(user, contest)) {
            return res.status(403).send('このコンテストを管理する権限がありません');
        }

        const problemIds = generateProblemIds(contest.problemCount);
        const start = DateTime.fromISO(contest.startTime, { zone: 'Asia/Tokyo' }).toFormat('M月d日 H:mm');
        const end = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' }).toFormat('M月d日 H:mm');

        const nav = generateNav(user);
        const content = `
            <section class="hero">
                <h2>${contest.title} 詳細</h2>
                <p>開始: ${start}</p>
                <p>終了: ${end}</p>
                <p>Tester: ${contest.testers.join(', ') || '未設定'}</p>
                <p>Writer: ${contest.writers.join(', ') || '未設定'}</p>
                <p>管理者: ${contest.managers.join(', ') || '未設定'}</p>
                <h3>Writer/Testerの追加</h3>
                <form method="POST" action="/admin/contest-details/${contestId}/add-writer-tester">
                    <label>ユーザー名 (カンマ区切りで複数指定可):</label><br>
                    <input type="text" name="usernames" placeholder="例: user1, user2" required><br>
                    <label>役割:</label><br>
                    <input type="radio" name="role" value="writer" required> Writer<br>
                    <input type="radio" name="role" value="tester"> Tester<br>
                    <button type="submit">追加</button>
                </form>
                <h3>講評</h3>
                <form method="POST" action="/admin/contest-details/${contestId}/update-review">
                    <textarea name="review" placeholder="コンテストの講評">${contest.review || ''}</textarea><br>
                    <button type="submit">講評を保存</button>
                </form>
                <table class="problem-table">
                    <tr><th>問題</th><th>点数</th><th>Writer</th><th>正解</th></tr>
                    ${problemIds
                        .map((problemId) => {
                            const problem =
                                contest.problems.find((p) => p.id === problemId) || {
                                    score: 100,
                                    writer: '未設定',
                                    correctAnswer: '',
                                };
                            return `
                                <tr>
                                    <td><a href="/admin/problem/${contestId}/${problemId}">${problemId}</a></td>
                                    <td>${problem.score || 100}</td>
                                    <td>${problem.writer || '未設定'}</td>
                                    <td>${problem.correctAnswer || '未設定'}</td>
                                </tr>
                            `;
                        })
                        .join('')}
                </table>
                <p><a href="/admin/edit-contest/${contestId}">編集</a></p>
                <p><a href="/contests">コンテスト一覧に戻る</a></p>
            </section>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('コンテスト詳細（管理者）エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

app.post('/admin/contest-details/:contestId/update-review', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (!canManageContest(user, contest)) {
            return res.status(403).send('このコンテストを管理する権限がありません');
        }

        contest.review = req.body.review || '';
        await saveContests(contests);
        res.redirect(`/admin/contest-details/${contestId}`);
    } catch (err) {
        console.error('講評更新エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

app.post('/admin/contest-details/:contestId/add-writer-tester', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (!canManageContest(user, contest)) {
            return res.status(403).send('このコンテストを管理する権限がありません');
        }

        const users = await loadUsers();
        const { usernames, role } = req.body;
        const usernameList = usernames
            .split(',')
            .map((u) => u.trim())
            .filter((u) => u);

        usernameList.forEach((username) => {
            if (users.find((u) => u.username === username)) {
                if (role === 'writer' && !contest.writers.includes(username)) {
                    contest.writers.push(username);
                } else if (role === 'tester' && !contest.testers.includes(username)) {
                    contest.testers.push(username);
                }
            }
        });

        await saveContests(contests);
        res.redirect(`/admin/contest-details/${contestId}`);
    } catch (err) {
        console.error('Writer/Tester追加エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：コンテスト編集
app.get('/admin/edit-contest/:contestId', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (!canManageContest(user, contest)) {
            return res.status(403).send('このコンテストを管理する権限がありません');
        }

        const problemIds = generateProblemIds(contest.problemCount);
        const startTimeFormatted = DateTime.fromISO(contest.startTime, { zone: 'Asia/Tokyo' }).toFormat("yyyy-MM-dd'T'HH:mm");
        const endTimeFormatted = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' }).toFormat("yyyy-MM-dd'T'HH:mm");

        const nav = generateNav(user);
        const content = `
            <section class="form-container">
                <h2>${contest.title} の編集</h2>
                <form method="POST" action="/admin/edit-contest/${contestId}">
                    <label>コンテスト名:</label><br>
                    <input type="text" name="title" value="${contest.title || ''}"><br>
                    <label>説明:</label><br>
                    <textarea name="description">${contest.description || ''}</textarea><br>
                    <label>開始時間:</label><br>
                    <input type="datetime-local" name="startTime" value="${startTimeFormatted}"><br>
                    <label>終了時間:</label><br>
                    <input type="datetime-local" name="endTime" value="${endTimeFormatted}"><br>
                    <label>Tester (カンマ区切りで入力):</label><br>
                    <input type="text" name="testers" value="${contest.testers.join(', ') || ''}"><br>
                    <label>Writer (カンマ区切りで入力):</label><br>
                    <input type="text" name="writers" value="${contest.writers.join(', ') || ''}"><br>
                    <label>1問題あたりの提出制限 (デフォルトは10):</label><br>
                    <select name="submissionLimit">
                        <option value="5" ${contest.submissionLimit === 5 ? 'selected' : ''}>5</option>
                        <option value="10" ${contest.submissionLimit === 10 ? 'selected' : ''}>10</option>
                    </select><br>
                    <h3>問題設定</h3>
                    ${problemIds
                        .map((problemId) => {
                            const problem = contest.problems.find((p) => p.id === problemId) || {};
                            return `
                                <div>
                                    <label>問題 ${problemId}</label><br>
                                    <input type="number" name="score_${problemId}" placeholder="点数" value="${problem.score || 100}"><br>
                                    <input type="text" name="writer_${problemId}" placeholder="作成者" value="${problem.writer || ''}"><br>
                                    <textarea name="content_${problemId}" placeholder="TeX使用可、各行を$$で囲む">${problem.content || ''}</textarea><br>
                                    <label>正解:</label><br>
                                    <input type="text" name="correctAnswer_${problemId}" value="${problem.correctAnswer || ''}" placeholder="正解を入力"><br>
                                    <label>画像URL (手動入力):</label><br>
                                    <input type="text" name="image_${problemId}" value="${problem.image || ''}" placeholder="画像のURLを入力"><br>
                                </div>
                            `;
                        })
                        .join('')}
                    <button type="submit">保存</button>
                </form>
                <p><a href="/admin/contest-details/${contestId}">詳細に戻る</a></p>
            </section>
        `;
        res.send(generatePage(nav, content, false));
    } catch (err) {
        console.error('コンテスト編集表示エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

app.post('/admin/edit-contest/:contestId', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (!canManageContest(user, contest)) {
            return res.status(403).send('このコンテストを管理する権限がありません');
        }

        const testers = (req.body.testers || '')
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t);
        const writers = (req.body.writers || '')
            .split(',')
            .map((w) => w.trim())
            .filter((w) => w);
        const title = req.body.title || contest.title || '';
        const description = req.body.description || contest.description || '';
        const submissionLimit = parseInt(req.body.submissionLimit) || contest.submissionLimit || 10;
        const problemIds = generateProblemIds(contest.problemCount);

        const startTime = req.body.startTime
            ? DateTime.fromISO(req.body.startTime, { zone: 'Asia/Tokyo' }).toISO()
            : contest.startTime;
        const endTime = req.body.endTime
            ? DateTime.fromISO(req.body.endTime, { zone: 'Asia/Tokyo' }).toISO()
            : contest.endTime;

        const problems = problemIds.map((problemId) => {
            const existingProblem = contest.problems.find((p) => p.id === problemId) || {};
            const score = parseInt(req.body[`score_${problemId}`]) || existingProblem.score || 100;
            const writer = req.body[`writer_${problemId}`] || existingProblem.writer || '';
            const content = req.body[`content_${problemId}`] || existingProblem.content || '';
            const correctAnswer = req.body[`correctAnswer_${problemId}`] || existingProblem.correctAnswer || '';
            const image = req.body[`image_${problemId}`] || existingProblem.image || '';
            const explanation = existingProblem.explanation || '';

            return { id: problemId, score, writer, content, correctAnswer, image, explanation };
        });

        contest.title = title;
        contest.description = description;
        contest.testers = testers;
        contest.writers = writers;
        contest.problems = problems;
        contest.submissionLimit = submissionLimit;
        contest.startTime = startTime;
        contest.endTime = endTime;

        await saveContests(contests);
        res.redirect(`/admin/contest-details/${contestId}`);
    } catch (err) {
        console.error('コンテスト編集処理エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// （既存のインポートや設定はそのまま）

// （既存のインポートや設定はそのまま）

// ルート：問題詳細（管理者）
app.get('/admin/problem/:contestId/:problemId', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);
        const problemId = req.params.problemId;

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (!canManageContest(user, contest)) {
            return res.status(403).send('このコンテストを管理する権限がありません');
        }

        const problem = contest.problems.find((p) => p.id === problemId) || {
            content: '問題が設定されていません',
            score: 100,
            writer: '未設定',
            image: '',
            explanation: '',
            explanationImage: '',
            imagePublicId: '',
            explanationImagePublicId: '',
        };

        let displayContent = problem.content || '未設定';
        displayContent = displayContent.replace(/\n(?![ \t]*\$)/g, '<br>');
        displayContent = wrapWithFlalign(displayContent);

        let displayExplanation = problem.explanation || '未設定';
        displayExplanation = displayExplanation.replace(/\n(?![ \t]*\$)/g, '<br>');
        displayExplanation = wrapWithFlalign(displayExplanation);

        const nav = generateNav(user);
        const content = `
        <section class="problem-section">
            <h2>${contest.title} - 問題 ${problemId}</h2>
            <div class="problem-display">
                <p>内容: <span class="math-tex">${displayContent}</span></p>
                <p>点数: ${problem.score}</p>
                <p>作成者: ${problem.writer || '未設定'}</p>
                <p>正解: ${problem.correctAnswer || '未設定'}</p>
                ${
                    problem.image 
                    ? `<p>問題画像: <img src="${problem.image}" alt="Problem Image" style="max-width: 300px; cursor: pointer;" onclick="showModal('${problem.image.replace(/'/g, "\\'")}')"></p>
                       <form method="POST" action="/admin/problem/${contestId}/${problemId}/remove-image" style="display:inline;">
                           <input type="hidden" name="imageType" value="image">
                           <button type="submit" onclick="return confirm('問題画像を取り消しますか？')">問題画像を取り消す</button>
                       </form>`
                    : '<p>問題画像: 未設定</p>'
                }
                <p>解説: <span class="math-tex">${displayExplanation}</span></p>
                ${
                    problem.explanationImage 
                    ? `<p>解説画像: <img src="${problem.explanationImage}" alt="Explanation Image" style="max-width: 300px; cursor: pointer;" onclick="showModal('${problem.explanationImage.replace(/'/g, "\\'")}')"></p>
                       <form method="POST" action="/admin/problem/${contestId}/${problemId}/remove-image" style="display:inline;">
                           <input type="hidden" name="imageType" value="explanationImage">
                           <button type="submit" onclick="return confirm('解説画像を取り消しますか？')">解説画像を取り消す</button>
                       </form>`
                    : '<p>解説画像: 未設定</p>'
                }
            </div>
            <h3>問題内容の編集</h3>
            <form method="POST" action="/admin/problem/${contestId}/${problemId}">
                <label>問題内容 (TeX使用可、各行を$$で囲む):</label><br>
                <textarea name="content" placeholder="問題内容">${problem.content || ''}</textarea><br>
                <label>点数:</label><br>
                <input type="number" name="score" value="${problem.score || 100}" required><br>
                <label>作成者:</label><br>
                <input type="text" name="writer" value="${problem.writer || ''}" placeholder="作成者"><br>
                <label>正解:</label><br>
                <input type="text" name="correctAnswer" value="${problem.correctAnswer || ''}" placeholder="正解を入力"><br>
                <label>解説 (TeX使用可):</label><br>
                <textarea name="explanation" placeholder="解答解説">${problem.explanation || ''}</textarea><br>
                <button type="submit">保存</button>
            </form>
            <h3>画像アップロード</h3>
            <form method="POST" action="/admin/problem/${contestId}/${problemId}/upload-image" enctype="multipart/form-data">
                <label>問題画像を選択:</label><br>
                <input type="file" name="image" accept="image/*"><br>
                <label>解説画像を選択:</label><br>
                <input type="file" name="explanationImage" accept="image/*"><br>
                <button type="submit">画像をアップロード</button>
            </form>
            <p><a href="/admin/contest-details/${contestId}">コンテスト詳細に戻る</a></p>
        </section>
    `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('問題詳細（管理者）エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// 問題内容の保存（画像フィールドを上書きしないように修正）
app.post('/admin/problem/:contestId/:problemId', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);
        const problemId = req.params.problemId;

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (!canManageContest(user, contest)) {
            return res.status(403).send('このコンテストを管理する権限がありません');
        }

        let problem = contest.problems.find((p) => p.id === problemId);
        if (!problem) {
            problem = { id: problemId, image: '', explanationImage: '', imagePublicId: '', explanationImagePublicId: '' };
            contest.problems.push(problem);
        }

        // 既存の画像フィールドを保持
        const existingImage = problem.image;
        const existingExplanationImage = problem.explanationImage;
        const existingImagePublicId = problem.imagePublicId;
        const existingExplanationImagePublicId = problem.explanationImagePublicId;

        problem.content = req.body.content || '';
        problem.score = parseInt(req.body.score) || 100;
        problem.writer = req.body.writer || '';
        problem.correctAnswer = req.body.correctAnswer || '';
        problem.explanation = req.body.explanation || '';
        problem.image = existingImage; // 既存の画像URLを保持
        problem.explanationImage = existingExplanationImage;
        problem.imagePublicId = existingImagePublicId;
        problem.explanationImagePublicId = existingExplanationImagePublicId;

        await saveContests(contests);
        res.redirect(`/admin/problem/${contestId}/${problemId}`);
    } catch (err) {
        console.error('問題編集エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// 画像アップロード処理（Cloudinaryを使用）
app.post('/admin/problem/:contestId/:problemId/upload-image', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);
        const problemId = req.params.problemId;

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (!canManageContest(user, contest)) {
            return res.status(403).send('このコンテストを管理する権限がありません');
        }

        const problem = contest.problems.find((p) => p.id === problemId);
        if (!problem) {
            return res.status(404).send('無効な問題IDです');
        }

        if (!req.files || (!req.files.image && !req.files.explanationImage)) {
            return res.status(400).send('少なくとも1つの画像ファイルを選択してください');
        }

        const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

        // 問題画像のアップロード
        if (req.files && req.files.image) {
            const imageFile = req.files.image;
            if (imageFile.size > MAX_FILE_SIZE) {
                return res.status(400).send('問題画像のサイズが大きすぎます（最大5MB）');
            }
            const imagePublicId = `contest_${contestId}/${problemId}_image_${Date.now()}`;
            const result = await cloudinary.uploader.upload(imageFile.tempFilePath, {
                folder: `contest_${contestId}`,
                public_id: imagePublicId,
            });
            problem.image = result.secure_url;
            problem.imagePublicId = imagePublicId;
            console.log('問題画像アップロード成功:', problem.image);
        }

        // 解説画像のアップロード
        if (req.files && req.files.explanationImage) {
            const explanationImageFile = req.files.explanationImage;
            if (explanationImageFile.size > MAX_FILE_SIZE) {
                return res.status(400).send('解説画像のサイズが大きすぎます（最大5MB）');
            }
            const explanationPublicId = `contest_${contestId}/${problemId}_explanation_${Date.now()}`;
            const result = await cloudinary.uploader.upload(explanationImageFile.tempFilePath, {
                folder: `contest_${contestId}`,
                public_id: explanationPublicId,
            });
            problem.explanationImage = result.secure_url;
            problem.explanationImagePublicId = explanationPublicId;
            console.log('解説画像アップロード成功:', problem.explanationImage);
        }

        await saveContests(contests);
        res.redirect(`/admin/problem/${contestId}/${problemId}`);
    } catch (err) {
        console.error('画像アップロード処理エラー:', err);
        res.status(500).send(`サーバーエラーが発生しました: ${err.message}`);
    }
});

// 画像削除処理（独立したルートとして定義）
app.post('/admin/problem/:contestId/:problemId/remove-image', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);
        const problemId = req.params.problemId;
        const { imageType } = req.body;

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (!canManageContest(user, contest)) {
            return res.status(403).send('このコンテストを管理する権限がありません');
        }

        const problem = contest.problems.find((p) => p.id === problemId);
        if (!problem) {
            return res.status(404).send('無効な問題IDです');
        }

        if (imageType === 'image' && problem.image) {
            if (problem.imagePublicId) {
                await cloudinary.uploader.destroy(problem.imagePublicId);
                console.log(`問題画像を削除しました: ${problem.imagePublicId}`);
            }
            problem.image = '';
            problem.imagePublicId = '';
        } else if (imageType === 'explanationImage' && problem.explanationImage) {
            if (problem.explanationImagePublicId) {
                await cloudinary.uploader.destroy(problem.explanationImagePublicId);
                console.log(`解説画像を削除しました: ${problem.explanationImagePublicId}`);
            }
            problem.explanationImage = '';
            problem.explanationImagePublicId = '';
        } else {
            return res.status(400).send('削除する画像がありません');
        }

        await saveContests(contests);
        res.redirect(`/admin/problem/${contestId}/${problemId}`);
    } catch (err) {
        console.error('画像削除エラー:', err);
        res.status(500).send(`サーバーエラーが発生しました: ${err.message}`);
    }
});

// （他のルートはそのまま）

// ルート：ユーザー管理ページ
app.get('/admin/users', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user || !user.isAdmin) return res.redirect('/login');
        const users = await loadUsers();
        const nav = generateNav(user);
        const content = `
            <section class="hero">
                <h2>ユーザー管理</h2>
                <table class="user-table">
                    <tr><th>ユーザー名</th><th>管理者権限</th><th>操作</th></tr>
                    ${users
                        .map((u, index) => `
                            <tr>
                                <td>${u.username}</td>
                                <td>${u.isAdmin ? 'はい' : 'いいえ'}</td>
                                <td>
                                    <form id="delete-user-form-${index}" action="/admin/delete-user" method="POST" style="display:inline;">
                                        <input type="hidden" name="index" value="${index}">
                                        <button type="button" onclick="confirmDeletion('delete-user-form-${index}')">削除</button>
                                    </form>
                                    ${
                                        !u.isAdmin
                                            ? `<form action="/admin/toggle-admin" method="POST" style="display:inline;">
                                                <input type="hidden" name="index" value="${index}">
                                                <button type="submit">管理者にする</button>
                                            </form>`
                                            : ''
                                    }
                                </td>
                            </tr>
                        `)
                        .join('')}
                </table>
                <p><a href="/admin">管理者ダッシュボードに戻る</a></p>
            </section>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('ユーザー管理ページエラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：ユーザー削除
app.post('/admin/delete-user', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user || !user.isAdmin) return res.redirect('/login');
        const { index } = req.body;
        const users = await loadUsers();
        const idx = parseInt(index);
        if (idx >= 0 && idx < users.length) {
            if (users[idx].username === user.username) {
                return res.status(403).send('自分自身を削除することはできません');
            }
            users.splice(idx, 1);
            await saveUsers(users);
        }
        res.redirect('/admin/users');
    } catch (err) {
        console.error('ユーザー削除エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：管理者権限の切り替え
app.post('/admin/toggle-admin', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user || !user.isAdmin) return res.redirect('/login');
        const { index } = req.body;
        const users = await loadUsers();
        const idx = parseInt(index);
        if (idx >= 0 && idx < users.length) {
            users[idx].isAdmin = !users[idx].isAdmin;
            await saveUsers(users);
        }
        res.redirect('/admin/users');
    } catch (err) {
        console.error('管理者権限切り替えエラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// サーバー起動
const PORT = process.env.PORT || 3000;
// 過去のコンテストを再計算する関数
const recalculatePastContests = async () => {
    try {
        console.log('過去のコンテストの再計算を開始します...');
        const users = await loadUsers();
        const contests = await loadContests();

        if (!users || users.length === 0) {
            console.log('ユーザーデータがありません。処理を中止します。');
            return;
        }

        if (!contests || contests.length === 0) {
            console.log('コンテストデータがありません。処理を中止します。');
            return;
        }

        // ユーザーのcontestHistoryをリセット、Ratingを初期化
        users.forEach(user => {
            user.contestHistory = [];
            user.rating = 100;
            console.log(`ユーザー ${user.username} のコンテスト履歴をリセットしました。初期Rating: ${user.rating}`);
        });

        // コンテストを終了時刻の古い順にソート
        const endedContests = contests
            .filter(contest => !isContestNotEnded(contest))
            .sort((a, b) => {
                return DateTime.fromISO(a.endTime).toJSDate().getTime() - DateTime.fromISO(b.endTime).toJSDate().getTime();
            });

        if (endedContests.length === 0) {
            console.log('終了したコンテストがありません。処理を中止します。');
            return;
        }

        // 各コンテストを順に処理
        for (const contest of endedContests) {
            console.log(`コンテスト "${contest.title}" の処理を開始します...`);
            const contestId = contests.indexOf(contest);

            if (!contest.startTime || !contest.endTime) {
                console.warn(`コンテスト ${contest.title} にstartTimeまたはendTimeがありません。スキップします。`);
                continue;
            }
            if (!contest.problemCount || !contest.problems || contest.problems.length === 0) {
                console.warn(`コンテスト ${contest.title} に問題がありません。スキップします。`);
                continue;
            }

            const endTime = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' }).toJSDate().getTime();
            const startTime = DateTime.fromISO(contest.startTime, { zone: 'Asia/Tokyo' }).toJSDate().getTime();

            // コンテスト期間中の提出のみを対象
            const submissionsDuringContest = (contest.submissions || []).filter(
                (sub) => {
                    if (!sub.date) {
                        console.warn(`提出データにdateがありません: ${JSON.stringify(sub)}`);
                        return false;
                    }
                    return new Date(sub.date).getTime() <= endTime;
                }
            );
            console.log(`コンテスト期間中の提出数: ${submissionsDuringContest.length}`);

            // 同一ユーザー・同一問題の最新の提出を保持
            const userSubmissionsDuringContestMap = new Map();
            submissionsDuringContest.forEach((sub) => {
                if (!sub.user || !sub.problemId) {
                    console.warn(`提出データにuserまたはproblemIdがありません: ${JSON.stringify(sub)}`);
                    return;
                }
                const key = `${contestId}-${sub.user}-${sub.problemId}`;
                const existingSub = userSubmissionsDuringContestMap.get(key);
                if (
                    !existingSub ||
                    (existingSub.result !== 'CA' && sub.result === 'CA') ||
                    (existingSub.result !== 'CA' &&
                        sub.result !== 'CA' &&
                        new Date(sub.date).getTime() > new Date(existingSub.date).getTime())
                ) {
                    userSubmissionsDuringContestMap.set(key, sub);
                }
            });
            const uniqueSubmissionsDuringContest = Array.from(userSubmissionsDuringContestMap.values());
            console.log(`ユニークな提出数: ${uniqueSubmissionsDuringContest.length}`);

            // 問題IDとスコアの設定
            const problemIds = generateProblemIds(contest.problemCount);
            const problemScores = {};
            contest.problems.forEach((problem) => {
                if (!problem.id) {
                    console.warn(`問題にidがありません: ${JSON.stringify(problem)}`);
                    return;
                }
                problemScores[problem.id] = problem.score || 100;
            });

            // Difficultyを計算
            contest.problems.forEach(problem => {
                try {
                    problem.difficulty = calculateDifficulty(contest, problem.id, users);
                    console.log(`問題 ${problem.id} のDifficulty: ${problem.difficulty}`);
                } catch (err) {
                    console.error(`問題 ${problem.id} のDifficulty計算でエラー:`, err);
                    problem.difficulty = 200;
                }
            });

            // ユーザーごとの統計を計算
            const userStats = {};
            submissionsDuringContest.forEach((sub) => {
                const username = sub.user;
                const problemId = sub.problemId;
                const result = sub.result;
                const submissionTime = new Date(sub.date).getTime();
                const timeSinceStart = (submissionTime - startTime) / 1000;

                if (!userStats[username]) {
                    userStats[username] = {
                        score: 0,
                        lastCATime: 0,
                        problems: {},
                        totalWABeforeCA: 0,
                    };
                }

                if (!userStats[username].problems[problemId]) {
                    userStats[username].problems[problemId] = {
                        status: 'none',
                        time: null,
                        waCountBeforeCA: 0,
                        waCount: 0,
                    };
                }

                const problemStat = userStats[username].problems[problemId];

                if (result === 'CA' && problemStat.status !== 'CA') {
                    problemStat.status = 'CA';
                    problemStat.time = timeSinceStart;
                    userStats[username].score += problemScores[problemId] || 0;
                    userStats[username].lastCATime = Math.max(
                        userStats[username].lastCATime,
                        timeSinceStart,
                    );
                } else if (result === 'WA' && problemStat.status !== 'CA') {
                    problemStat.waCountBeforeCA += 1;
                    problemStat.waCount += 1;
                    problemStat.status = 'WA';
                } else if (result === 'WA') {
                    problemStat.waCount += 1;
                }
            });

            // WAペナルティの計算
            Object.keys(userStats).forEach((username) => {
                userStats[username].totalWABeforeCA = Object.values(
                    userStats[username].problems,
                ).reduce((sum, p) => sum + (p.status === 'CA' ? p.waCountBeforeCA : 0), 0);
            });

            // ランキングの計算
            const rankings = Object.keys(userStats).map((username) => {
                const stats = userStats[username];
                const penaltyTime = stats.totalWABeforeCA * 300;
                return {
                    username,
                    score: stats.score,
                    lastCATime: stats.lastCATime + penaltyTime,
                    problems: stats.problems,
                    totalWABeforeCA: stats.totalWABeforeCA,
                };
            });

            rankings.sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return a.lastCATime - b.lastCATime;
            });
            console.log(`ランキング: ${JSON.stringify(rankings.map(r => ({ username: r.username, score: r.score })), null, 2)}`);

            // 提出がないユーザーもランキングに含める（最低限のPerformanceを付与）
            users.forEach(user => {
                if (!userStats[user.username]) {
                    rankings.push({
                        username: user.username,
                        score: 0,
                        lastCATime: 0,
                        problems: {},
                        totalWABeforeCA: 0,
                    });
                    console.log(`ユーザー ${user.username} は提出がありません。ランキングに追加しました。`);
                }
            });

            // PerformanceとRatingの計算
            const userPerformances = {};
            rankings.forEach((rank, index) => {
                const rankPosition = index + 1;
                try {
                    const performance = calculatePerformance(contest, rank.username, rankPosition, contests);
                    userPerformances[rank.username] = performance;
                    console.log(`ユーザー ${rank.username} のPerformance: ${performance}`);
                } catch (err) {
                    console.error(`ユーザー ${rank.username} のPerformance計算でエラー:`, err);
                    userPerformances[rank.username] = 100;
                }
            });

            // ユーザーのRatingを更新し、履歴に保存
            for (const [username, performance] of Object.entries(userPerformances)) {
                const targetUser = users.find(u => u.username === username);
                if (targetUser) {
                    try {
                        const previousRating = targetUser.rating;
                        const newRating = updateUserRating(targetUser, performance);
                        targetUser.contestHistory.push({
                            contestId: contestId,
                            contestTitle: contest.title || `Contest ${contestId}`,
                            rank: rankings.findIndex(r => r.username === username) + 1,
                            performance: performance,
                            ratingBeforeContest: previousRating,
                            ratingAfterContest: newRating,
                            endTime: contest.endTime,
                        });
                        console.log(`ユーザー ${username} のRating更新: ${previousRating} -> ${newRating}`);
                    } catch (err) {
                        console.error(`ユーザー ${username} のRating更新でエラー:`, err);
                    }
                } else {
                    console.warn(`ユーザー ${username} が見つかりません。`);
                }
            }

            // コンテストにPerformanceを保存
            contest.userPerformances = Object.entries(userPerformances).map(([username, performance]) => ({
                username,
                performance,
            }));
            console.log(`コンテスト "${contest.title}" のuserPerformancesを保存しました。`);
        }

        // 更新されたデータを保存
        console.log('ユーザーデータを保存します...');
        await saveUsers(users);
        console.log('コンテストデータを保存します...');
        await saveContests(contests);
        console.log('過去のコンテストの再計算が完了しました。');
    } catch (err) {
        console.error('過去のコンテスト再計算エラー:', err);
        throw err;
    }
};

// ポート番号を環境変数から取得、デフォルトは3000
const port = process.env.PORT || 3000;

// サーバー起動時に過去のコンテストを再計算
app.listen(port, async () => {
    console.log(`サーバーがポート${port}で起動しました`);
    await recalculatePastContests();
});

// MongoDB接続の初期化
connectToMongo().catch((err) => {
    console.error('MongoDB初期接続エラー:', err);
    process.exit(1);
});