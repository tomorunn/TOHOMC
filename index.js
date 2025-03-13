const express = require('express');
const { DateTime } = require('luxon');
const path = require('path');
const cookieParser = require('cookie-parser');
const { MongoClient } = require('mongodb');
const formidable = require('formidable');
const cloudinary = require('cloudinary').v2;
const fileUpload = require('express-fileupload');

const app = express();

require('dotenv').config();

// Cloudinaryの設定
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
}));

// MongoDB 接続設定
const uri = process.env.MONGO_URI;
console.log("MONGO_URI:", uri); // デバッグ用
const client = new MongoClient(uri);
let db;

async function connectToMongo() {
    if (!db) {
        console.log("MongoDBに接続しようとしています...");
        console.log("MONGO_URI:", process.env.MONGO_URI);
        try {
            await client.connect();
            db = client.db('contest');
            console.log("MongoDBに接続できました！");
        } catch (err) {
            console.error("MongoDBに接続失敗:", err);
            throw err;
        }
    }
    return db;
}

// ユーザー情報の読み込み
const loadUsers = async () => {
    try {
        const database = await connectToMongo();
        const collection = database.collection('users');
        const users = await collection.find({}).toArray();
        return users.length > 0 ? users : [
            { username: 'admin', password: 'admin123', isAdmin: true },
            { username: 'user', password: 'pass123', isAdmin: false },
        ];
    } catch (err) {
        console.error('ユーザーの読み込みエラー:', err);
        return [
            { username: 'admin', password: 'admin123', isAdmin: true },
            { username: 'user', password: 'pass123', isAdmin: false },
        ];
    }
};

// ユーザーの保存
const saveUsers = async (users) => {
    try {
        const database = await connectToMongo();
        const collection = database.collection('users');
        await collection.deleteMany({});
        const result = await collection.insertMany(users);
        console.log("Users saved:", result.insertedCount);
    } catch (err) {
        console.error('ユーザーの保存エラー:', err);
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
            problems: contest.problems || [],
            managers: contest.managers || [],
            submissions: contest.submissions || [],
            review: contest.review || '',
        }));
    } catch (err) {
        console.error('コンテストの読み込みエラー:', err);
        return [];
    }
};

// コンテストの保存
const saveContests = async (contests) => {
    try {
        const database = await connectToMongo();
        const collection = database.collection('contests');
        console.log("保存するコンテストデータ:", contests);
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
const generateNav = (user) => {
    if (user) {
        return `
            <nav>
                <div class="nav-container">
                    <h1>TOHOMC</h1>
                    <ul>
                        <li><a href="/">ホーム</a></li>
                        <li><a href="/contests">コンテスト</a></li>
                        <li><a href="/problems">PROBLEMS</a></li>
                        <li><a href="/admin">管理者ダッシュボード</a></li>
                        <li style="color: #fff;">Hi, ${user.username}</li>
                        <li><a href="/logout">ログアウト</a></li>
                    </ul>
                </div>
            </nav>
        `;
    }
    return `
        <nav>
            <div class="nav-container">
                <h1>TOHOMC</h1>
                <ul>
                    <li><a href="/">ホーム</a></li>
                    <li><a href="/contests">コンテスト</a></li>
                    <li><a href="/problems">PROBLEMS</a></li>
                    <li><a href="/login">ログイン</a></li>
                    <li><a href="/register">新規登録</a></li>
                </ul>
            </div>
        </nav>
    `;
};

// TeX内容を左揃えにするためのラッパー関数
const wrapWithFlalign = (content) => {
    if (!content) return '';
    if (content.includes('\\begin{flalign}') || content.includes('\\end{flalign}')) {
        return content;
    }
    const displayMathPattern = /\$\$(.*?)\$\$|\[(.*?)\]/gs;
    return content.replace(displayMathPattern, (match, p1, p2) => {
        const innerContent = p1 || p2 || '';
        return `$$\\begin{flalign}${innerContent}\\end{flalign}$$`;
    });
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
        </style>
        <script>
            // formatTime関数をグローバルスコープに定義
            window.formatTime = function(seconds) {
                const hours = Math.floor(seconds / 3600);
                const minutes = Math.floor((seconds % 3600) / 60);
                const secs = seconds % 60;
                return \`\${hours}:\${minutes < 10 ? '0' : ''}\${minutes}:\${secs < 10 ? '0' : ''}\${secs}\`;
            };
            console.log('formatTime function defined:', typeof window.formatTime);

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
                            console.log('MathJax is loaded and initialized');
                            MathJax.typesetPromise();
                        });
                    }
                }
            };
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

// ユーザー取得関数（修正：エラー防止とデバッグ強化）
const getUserFromCookie = async (req) => {
    try {
        const username = req.cookies.username;
        console.log('Cookie username:', username); // デバッグ用
        if (!username) {
            console.log('クッキーにusernameが見つかりません');
            return null;
        }
        const users = await loadUsers();
        const user = users.find((u) => u.username === username) || null;
        console.log('Found user:', user); // デバッグ用
        return user;
    } catch (err) {
        console.error('getUserFromCookieエラー:', err);
        return null;
    }
};

// コンテスト管理権限のチェック関数（修正：安全性向上）
const canManageContest = (user, contest) => {
    if (!user || !user.username) {
        console.log('ユーザー情報が不正（canManageContest）:', user);
        return false;
    }
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
    console.log("現在時刻(JST):", now.toISO(), "終了時刻(JST):", end.toISO());
    return now < end;
};

// コンテストが開始済みかをチェックする関数
const hasContestStarted = (contest) => {
    const now = DateTime.now().setZone('Asia/Tokyo');
    const start = DateTime.fromISO(contest.startTime, { zone: 'Asia/Tokyo' });
    console.log("現在時刻(JST):", now.toISO(), "開始時刻(JST):", start.toISO());
    return now >= start;
};

// コンテストが開催中かをチェックする関数
const isContestStartedOrActive = (contest) => {
    const now = DateTime.now().setZone('Asia/Tokyo');
    const start = DateTime.fromISO(contest.startTime, { zone: 'Asia/Tokyo' });
    const end = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' });
    console.log("現在時刻(JST):", now.toISO(), "開始時刻(JST):", start.toISO(), "終了時刻(JST):", end.toISO());
    return now >= start && now <= end;
};

// 問題ID生成関数
const generateProblemIds = (count) => {
    return Array.from({ length: count }, (_, i) => String.fromCharCode(65 + i)); // A, B, C, ...
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
            console.log('Login successful for:', username, 'isAdmin:', user.isAdmin);
            if (user.isAdmin) {
                return res.redirect('/admin');
            }
            return res.redirect('/contests');
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
        const users = await loadUsers();
        const { username, password } = req.body;
        if (users.find((u) => u.username === username)) {
            return res.send('ユーザー名が既に存在します <a href="/register">戻る</a>');
        }
        users.push({ username, password, isAdmin: false });
        await saveUsers(users);
        res.redirect('/login');
    } catch (err) {
        console.error('新規登録処理エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：管理者ダッシュボード
app.get('/admin', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        console.log('Accessing /admin, user:', user);
        if (!user || !user.username) {
            console.log('No user found, redirecting to /login');
            return res.redirect('/login');
        }
        if (!user.isAdmin) {
            console.log('User is not admin, redirecting to /contests');
            return res.redirect('/contests');
        }
        const contests = await loadContests();
        const nav = generateNav(user);
        const content = `
            <section class="hero">
                <h2>管理者ダッシュボード</h2>
                <p>ここでコンテストとユーザーの管理ができます。</p>
                <form action="/admin/add-contest" method="GET">
                    <button type="submit">コンテストを追加</button>
                </form>
                <h3>現在のコンテスト</h3>
                <ul>
                    ${
                        contests
                            .map(
                                (contest, index) => {
                                    const start = DateTime.fromISO(contest.startTime, { zone: 'Asia/Tokyo' }).toLocaleString(DateTime.DATETIME_FULL);
                                    const end = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' }).toLocaleString(DateTime.DATETIME_FULL);
                                    return `
                                        <li>
                                            ${contest.title} (開始: ${start}, 終了: ${end})
                                            <form action="/admin/delete-contest" method="POST" style="display:inline;">
                                                <input type="hidden" name="index" value="${index}">
                                                <button type="submit">削除</button>
                                            </form>
                                            <a href="/admin/contest-details/${index}">詳細</a>
                                            <a href="/admin/edit-contest/${index}">編集</a>
                                        </li>
                                    `;
                                }
                            )
                            .join('') || '<p>コンテストがありません</p>'
                    }
                </ul>
                <h3>ユーザー管理</h3>
                <a href="/admin/users">ユーザー管理ページへ</a>
            </section>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('管理者ダッシュボードエラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：コンテスト追加
app.get('/admin/add-contest', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user || !user.username || !user.isAdmin) return res.redirect('/login');
        const nav = generateNav(user);
        const content = `
            <section class="form-container">
                <h2>新しいコンテストの作成</h2>
                <form method="POST" action="/admin/add-contest">
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
                    <button type="submit">コンテストを作成</button>
                </form>
                <p><a href="/admin">管理者ダッシュボードに戻る</a></p>
            </section>
        `;
        res.send(generatePage(nav, content, false));
    } catch (err) {
        console.error('コンテスト追加表示エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

app.post('/admin/add-contest', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user || !user.username || !user.isAdmin) return res.redirect('/login');
        const { title, description, startTime, endTime, problemCount } = req.body;
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
        });
        await saveContests(contests);
        res.redirect('/admin');
    } catch (err) {
        console.error('コンテスト追加処理エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：コンテスト削除
app.post('/admin/delete-contest', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user || !user.username || !user.isAdmin) return res.redirect('/login');
        const { index } = req.body;
        const contests = await loadContests();
        const idx = parseInt(index);
        if (idx >= 0 && idx < contests.length) {
            contests.splice(idx, 1);
            await saveContests(contests);
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
        console.log("現在の日本時間:", DateTime.now().setZone('Asia/Tokyo').toISO());
        console.log("読み込んだコンテスト:", contests);
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
                                    const start = DateTime.fromISO(contest.startTime, { zone: 'Asia/Tokyo' }).toLocaleString(DateTime.DATETIME_FULL);
                                    const end = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' }).toLocaleString(DateTime.DATETIME_FULL);
                                    const status = isContestStartedOrActive(contest)
                                        ? '開催中'
                                        : '準備中';
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
        res.status(500).send(`サーバーエラーが発生しました: ${err.message}`);
    }
});

// ルート：コンテスト詳細（問題一覧ページ）
app.get('/contest/:contestId', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user || !user.username) return res.redirect('/login');
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
        if (!user || !user.username) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (isContestNotEnded(contest)) {
            return res
                .status(403)
                .send(
                    'コンテストが終了していないため講評は閲覧できません。 <a href="/contest/' +
                        contestId +
                        '">戻る</a>',
                );
        }

        const nav = generateNav(user);
        const content = `
            <section class="hero">
                <h2>${contest.title} - 講評</h2>
                <p>${
                    contest.review.replace(/\n/g, '<br>') || '講評がまだ書かれていません。'
                }</p>
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
        if (!user || !user.username) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        const nav = generateNav(user);
        const submissions = contest.submissions || [];
        let filteredSubmissions;
        if (canManageContest(user, contest)) {
            filteredSubmissions = submissions;
        } else {
            filteredSubmissions = submissions.filter((sub) => sub.user === user.username);
        }
        const content = `
            <section class="hero">
                <h2>${contest.title} - 提出一覧</h2>
                <div class="tabs">
                    <a href="/contest/${contestId}" class="tab">問題</a>
                    <a href="/contest/${contestId}/submissions" class="tab active">提出一覧</a>
                    <a href="/contest/${contestId}/ranking" class="tab">ランキング</a>
                </div>
                <table class="result-table">
                    <tr><th>Date</th><th>Problem</th><th>User</th><th>Result</th><th>Answer</th></tr>
                    ${
                        filteredSubmissions
                            .map((sub) => {
                                const style =
                                    sub.result === 'CA'
                                        ? 'background-color: #90ee90'
                                        : sub.result === 'WA'
                                        ? 'background-color: #ffcccc'
                                        : '';
                                return `
                                    <tr>
                                        <td>${DateTime.fromISO(sub.date, { zone: 'Asia/Tokyo' }).toLocaleString(DateTime.DATETIME_FULL)}</td>
                                        <td>${sub.problemId}</td>
                                        <td>${sub.user}</td>
                                        <td style="${style}">${sub.result}</td>
                                        <td>${sub.answer}</td>
                                    </tr>
                                `;
                            })
                            .join('') || '<tr><td colspan="5">提出履歴がありません</td></tr>'
                    }
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
        console.error('提出一覧エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：ランキング
app.get('/contest/:contestId/ranking', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user || !user.username) return res.redirect('/login');
        const contests = await loadContests();
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

        const nav = generateNav(user);
        const content = `
            <section class="hero">
                <h2>${contest.title} - ランキング</h2>
                <div class="tabs">
                    <a href="/contest/${contestId}" class="tab">問題</a>
                    <a href="/contest/${contestId}/submissions" class="tab">提出一覧</a>
                    <a href="/contest/${contestId}/ranking" class="tab active">ランキング</a>
                </div>
                <table class="ranking-table" id="rankingTable">
                    <tr>
                        <th>#</th>
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
                    ${rankings
                        .map((rank, index) => {
                            const isCurrentUser = rank.username === user.username;
                            return `
                                <tr class="ranking-row" data-index="${index}">
                                    <td>${index + 1}</td>
                                    <td style="${
                                        isCurrentUser ? 'font-weight: bold;' : ''
                                    }">${rank.username}</td>
                                    <td>${rank.score}</td>
                                    <td class="last-ca-time" data-time="${Math.floor(
                                        rank.lastCATime,
                                    )}">${rank.totalWABeforeCA}</td>
                                    ${problemIds
                                        .map((problemId) => {
                                            const problem =
                                                rank.problems[problemId] || {
                                                    status: 'none',
                                                    waCount: 0,
                                                    time: null,
                                                };
                                            if (problem.status === 'CA') {
                                                return `<td style="background-color: #90ee90;" class="problem-time" data-time="${
                                                    Math.floor(problem.time) || 0
                                                }">${problem.waCount}</td>`;
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
                        .join('') ||
                        '<tr><td colspan="' +
                            (4 + problemIds.length) +
                            '">ランキングがありません</td></tr>'
                    }
                </table>
                <p><a href="${
                    hasContestStarted(contest) ? '/contests' : '/problems'
                }">${
                    hasContestStarted(contest) ? 'コンテスト一覧' : 'PROBLEMSページ'
                }に戻る</a></p>
            </section>
            <script>
                document.addEventListener('DOMContentLoaded', function() {
                    console.log('DOM fully loaded, formatTime available:', typeof window.formatTime);
                    if (typeof window.formatTime !== 'function') {
                        console.error('formatTime is not defined!');
                        return;
                    }

                    const firstFA = ${JSON.stringify(firstFA)};
                    const startTime = ${startTime};
                    document.querySelectorAll('.first-fa').forEach(cell => {
                        const problemId = cell.getAttribute('data-problem-id');
                        if (firstFA[problemId]) {
                            const faTime = Math.floor((firstFA[problemId].time - startTime) / 1000);
                            cell.innerHTML = \`FA: \${firstFA[problemId].user}<br>\${window.formatTime(faTime)}\`;
                        } else {
                            cell.innerHTML = 'CA者なし';
                        }
                    });

                    document.querySelectorAll('.ranking-row').forEach(row => {
                        const lastCaCell = row.querySelector('.last-ca-time');
                        const lastCaTime = parseInt(lastCaCell.getAttribute('data-time'));
                        lastCaCell.innerHTML = window.formatTime(lastCaTime) + '<br>+' + lastCaCell.textContent;

                        row.querySelectorAll('.problem-time').forEach(cell => {
                            const time = parseInt(cell.getAttribute('data-time'));
                            cell.innerHTML = window.formatTime(time) + '<br>+' + cell.textContent;
                        });
                    });
                });
            </script>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('ランキングエラー詳細:', err);
        res.status(500).send("サーバーエラーが発生しました: " + err.message);
    }
});

// ルート：問題提出ページ
app.get('/contest/:contestId/submit/:problemId', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user || !user.username) return res.redirect('/login');
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
                <div class="problem-display">
                    <p>内容: <span class="math-tex">${displayContent}</span></p>
                    <p>点数: ${problem.score}</p>
                    <p>作成者: ${problem.writer || '未設定'}</p>
                    ${
                        problem.image
                            ? `<p>画像: <img src="${problem.image}" alt="Problem Image" style="max-width: 300px;"></p>`
                            : ''
                    }
                </div>
        `;

        if (!isContestNotEnded(contest) && problem.explanation) {
            content += `<p><a href="/contest/${contestId}/explanation/${problemId}">解答解説を見る</a></p>`;
        }

        if (isContestStartedOrActive(contest) && canManageContest(user, contest)) {
            content += `
                <p style="color: red;">あなたはこのコンテストの管理者権限を持っているため、開催中に問題に回答することはできません。</p>
                <p><a href="/contest/${contestId}">問題一覧に戻る</a></p>
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
                <p><a href="${
                    hasContestStarted(contest)
                        ? '/contest/' + contestId
                        : '/problems'
                }">${
                    hasContestStarted(contest) ? '問題一覧' : 'PROBLEMSページ'
                }に戻る</a></p>
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

        content += `</section>`;
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
        if (!user || !user.username) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);
        const problemId = req.params.problemId;

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (isContestNotEnded(contest)) {
            return res
                .status(403)
                .send(
                    'コンテストが終了していないため解説は閲覧できません。 <a href="/contest/' +
                        contestId +
                        '/submit/' +
                        problemId +
                        '">戻る</a>',
                );
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
        if (!user || !user.username) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);
        const problemId = req.params.problemId;

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (isContestStartedOrActive(contest) && canManageContest(user, contest)) {
            return res
                .status(403)
                .send(
                    'あなたはこのコンテストの管理者権限を持っているため、開催中に問題に回答することはできません。 <a href="/contest/' +
                        contestId +
                        '">戻る</a>',
                );
        }

        const problem = contest.problems.find((p) => p.id === problemId);
        if (!problem) {
            return res.status(404).send('無効な問題IDです');
        }

        const endTime = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' }).toJSDate().getTime();
        const submissionsDuringContest = (contest.submissions || [])
            .filter(
                (sub) =>
                    sub.user === user.username &&
                    sub.problemId === problemId &&
                    new Date(sub.date).getTime() <= endTime,
            );
        if (isContestStartedOrActive(contest) && submissionsDuringContest.length >= 10) {
            return res
                .status(403)
                .send(
                    'コンテスト中にこの問題に提出できるのは10回までです。 <a href="/contest/' +
                        contestId +
                        '/submit/' +
                        problemId +
                        '">戻る</a>',
                );
        }

        const submittedAnswer = req.body.answer.trim();
        const regex = /^[0-9]+$/;
        if (!regex.test(submittedAnswer)) {
            return res
                .status(400)
                .send(
                    '解答は半角数字のみで入力してください。 <a href="/contest/' +
                        contestId +
                        '/submit/' +
                        problemId +
                        '">戻る</a>',
                );
        }

        const correctAnswer = problem.correctAnswer
            ? problem.correctAnswer.toString().trim()
            : null;
        let result = '未判定';
        if (correctAnswer) {
            result = submittedAnswer === correctAnswer ? 'CA' : 'WA';
        } else {
            result = '正解が設定されていません';
        }

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
        res.status(500).send("サーバーエラーが発生しました: " + err.message);
    }
});

// ルート：過去の問題
app.get('/problems', async (req, res) => {
    console.log('リクエスト受信: /problems');
    try {
        const user = await getUserFromCookie(req);
        console.log('ユーザー:', user ? user.username : 'なし');
        if (!user || !user.username) {
            console.log('ログインしていないのでリダイレクト');
            return res.redirect('/login');
        }
        const contests = await loadContests();
        console.log('コンテスト数:', contests.length);
        const nav = generateNav(user);
        const endedContests = contests.filter((contest) => !isContestNotEnded(contest));

        const content = `
            <section class="hero">
                <h2>終了したコンテストの問題</h2>
                <p>過去のコンテストの問題を閲覧できます。</p>
                <ul class="contest-list">
                    ${
                        endedContests
                            .map((contest) => {
                                const start = DateTime.fromISO(contest.startTime, { zone: 'Asia/Tokyo' }).toLocaleString(DateTime.DATETIME_FULL);
                                const end = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' }).toLocaleString(DateTime.DATETIME_FULL);
                                return `
                                    <li>
                                        <h3>${contest.title}</h3>
                                        <p>${contest.description}</p>
                                        <p>開始: ${start}</p>
                                        <p>終了: ${end}</p>
                                        <ul class="problem-list-horizontal">
                                            ${contest.problems
                                                .map((problem) => {
                                                    const userSubmissions = (
                                                        contest.submissions || []
                                                    ).filter(
                                                        (sub) =>
                                                            sub.user === user.username &&
                                                            sub.problemId === problem.id,
                                                    );
                                                    const isCA = userSubmissions.some(
                                                        (sub) => sub.result === 'CA',
                                                    );
                                                    return `
                                                        <li style="background-color: ${
                                                            isCA ? '#90ee90' : 'white'
                                                        };">
                                                            <a href="/contest/${contests.indexOf(
                                                                contest,
                                                            )}/submit/${problem.id}">問題 ${
                                                                problem.id
                                                            } (点数: ${problem.score})</a>
                                                        </li>
                                                    `;
                                                })
                                                .join('')}
                                        </ul>
                                        <p><a href="/contest/${contests.indexOf(
                                            contest,
                                        )}">問題</a> | <a href="/contest/${contests.indexOf(
                                            contest,
                                        )}/submissions">提出一覧</a> | <a href="/contest/${contests.indexOf(
                                            contest,
                                        )}/ranking">ランキング</a></p>
                                    </li>
                                `;
                            })
                            .join('') || '<p>終了したコンテストはありません。</p>'
                    }
                </ul>
                <p><a href="/">ホームに戻る</a></p>
            </section>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('過去の問題エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：コンテスト詳細（管理者）
app.get('/admin/contest-details/:contestId', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user || !user.username) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (!canManageContest(user, contest)) {
            return res
                .status(403)
                .send('このコンテストを管理する権限がありません <a href="/contests">戻る</a>');
        }

        const problemIds = generateProblemIds(contest.problemCount);
        const start = DateTime.fromISO(contest.startTime, { zone: 'Asia/Tokyo' }).toLocaleString(DateTime.DATETIME_FULL);
        const end = DateTime.fromISO(contest.endTime, { zone: 'Asia/Tokyo' }).toLocaleString(DateTime.DATETIME_FULL);

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
                    <textarea name="review" placeholder="コンテストの講評">${
                        contest.review || ''
                    }</textarea><br>
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
        if (!user || !user.username) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (!canManageContest(user, contest)) {
            return res
                .status(403)
                .send('このコンテストを管理する権限がありません <a href="/contests">戻る</a>');
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
        if (!user || !user.username) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (!canManageContest(user, contest)) {
            return res
                .status(403)
                .send('このコンテストを管理する権限がありません <a href="/contests">戻る</a>');
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
        if (!user || !user.username) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (!canManageContest(user, contest)) {
            return res
                .status(403)
                .send('このコンテストを管理する権限がありません <a href="/contests">戻る</a>');
        }

        const problemIds = generateProblemIds(contest.problemCount);

        const nav = generateNav(user);
        const content = `
            <section class="form-container">
                <h2>${contest.title} の編集</h2>
                <form method="POST" action="/admin/edit-contest/${contestId}">
                    <label>コンテスト名:</label><br>
                    <input type="text" name="title" value="${contest.title}" required><br>
                    <label>説明:</label><br>
                    <textarea name="description">${contest.description}</textarea><br>
                    <label>Tester (カンマ区切りで入力):</label><br>
                    <input type="text" name="testers" value="${
                        contest.testers.join(', ') || ''
                    }" required><br>
                    <label>Writer (カンマ区切りで入力):</label><br>
                    <input type="text" name="writers" value="${
                        contest.writers.join(', ') || ''
                    }" required><br>
                    <h3>問題設定</h3>
                    ${problemIds
                        .map((problemId) => {
                            const problem = contest.problems.find((p) => p.id === problemId) || {};
                            return `
                                <div>
                                    <label>問題 ${problemId}</label><br>
                                    <input type="number" name="score_${problemId}" placeholder="点数" value="${
                                        problem.score || 100
                                    }" required><br>
                                    <input type="text" name="writer_${problemId}" placeholder="作成者" value="${
                                        problem.writer || ''
                                    }" required><br>
                                    <textarea name="content_${problemId}" placeholder="問題内容 (TeX使用可, $$...$$で囲む。複数行は\\を使用。左揃えにする場合は\\begin{flalign}を使用)">${
                                        problem.content || ''
                                    }</textarea><br>
                                    <label>正解:</label><br>
                                    <input type="text" name="correctAnswer_${problemId}" value="${
                                        problem.correctAnswer || ''
                                    }" placeholder="正解を入力 (例: 42, x=5)"><br>
                                    <label>画像URL (手動入力):</label><br>
                                    <input type="text" name="image_${problemId}" value="${
                                        problem.image || ''
                                    }" placeholder="画像のURLを入力"><br>
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
        if (!user || !user.username) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (!canManageContest(user, contest)) {
            return res
                .status(403)
                .send('このコンテストを管理する権限がありません <a href="/contests">戻る</a>');
        }

        const testers = req.body.testers
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t);
        const writers = req.body.writers
            .split(',')
            .map((w) => w.trim())
            .filter((w) => w);
        const title = req.body.title || contest.title;
        const description = req.body.description || contest.description;
        const problemIds = generateProblemIds(contest.problemCount);

        const problems = problemIds.map((problemId) => {
            const score = parseInt(req.body[`score_${problemId}`]) || 100;
            const writer = req.body[`writer_${problemId}`] || '未設定';
            const content = req.body[`content_${problemId}`] || '';
            const correctAnswer = req.body[`correctAnswer_${problemId}`] || '';
            const existingProblem = contest.problems.find((p) => p.id === problemId) || {};
            const image = req.body[`image_${problemId}`] || existingProblem.image || '';
            const explanation = existingProblem.explanation || '';

            return { id: problemId, score, writer, content, correctAnswer, image, explanation };
        });

        contest.title = title;
        contest.description = description;
        contest.testers = testers;
        contest.writers = writers;
        contest.problems = problems;
        await saveContests(contests);
        res.redirect(`/admin/contest-details/${contestId}`);
    } catch (err) {
        console.error('コンテスト編集処理エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：問題詳細（管理者）
app.get('/admin/problem/:contestId/:problemId', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user || !user.username) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);
        const problemId = req.params.problemId;

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (!canManageContest(user, contest)) {
            return res
                .status(403)
                .send('このコンテストを管理する権限がありません <a href="/contests">戻る</a>');
        }

        const problem =
            contest.problems.find((p) => p.id === problemId) || {
                content: '問題が設定されていません',
                score: 100,
                writer: '未設定',
                image: '',
                explanation: '',
            };

        let displayContent = problem.content || '未設定';
        displayContent = displayContent.replace(/\n(?![ \t]*\$)/g, '<br>');
        displayContent = wrapWithFlalign(displayContent);

        const nav = generateNav(user);
        const content = `
            <section class="problem-section">
                <h2>${contest.title} - 問題 ${problemId}</h2>
                <div class="problem-display">
                    <p>内容: <span class="math-tex">${displayContent}</span></p>
                    <p>点数: ${problem.score}</p>
                    <p>作成者: ${problem.writer}</p>
                    ${
                        problem.image
                            ? `<p>画像: <img src="${problem.image}" alt="Problem Image" style="max-width: 300px;"></p>`
                            : ''
                    }
                </div>
                <form method="POST" action="/admin/problem/${contestId}/${problemId}" class="problem-form">
                    <label>内容 (TeX使用可, $$...$$で囲む。複数行は\\を使用。左揃えにする場合は\\begin{flalign}を使用):</label><br>
                    <textarea name="content">${problem.content || ''}</textarea><br>
                    <label>点数:</label><br>
                    <input type="number" name="score" value="${problem.score}" required><br>
                    <label>作成者:</label><br>
                    <input type="text" name="writer" value="${problem.writer}" required><br>
                    <label>正解:</label><br>
                    <input type="text" name="correctAnswer" value="${
                        problem.correctAnswer || ''
                    }" placeholder="正解を入力 (例: 42, x=5)"><br>
                    <label>画像URL (手動入力またはアップロード後自動反映):</label><br>
                    <input type="text" name="image" value="${
                        problem.image || ''
                    }" placeholder="画像のURLを入力"><br>
                    <label>解答解説 (TeX使用可):</label><br>
                    <textarea name="explanation">${problem.explanation || ''}</textarea><br>
                    <button type="submit">保存</button>
                </form>
                <form method="POST" action="/admin/problem/${contestId}/${problemId}/upload" enctype="multipart/form-data" class="upload-form">
                    <label>画像をアップロード:</label><br>
                    <input type="file" name="image" accept="image/*" required><br>
                    <button type="submit">アップロード</button>
                </form>
                <p><a href="/admin/contest-details/${contestId}">戻る</a></p>
            </section>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('問題詳細（管理者）エラー:', err);
        res.status(500).send('サーバーエラーが発生しました');
    }
});

app.post('/admin/problem/:contestId/:problemId', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user || !user.username) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);
        const problemId = req.params.problemId;

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }
        const contest = contests[contestId];
        if (!canManageContest(user, contest)) {
            return res
                .status(403)
                .send('このコンテストを管理する権限がありません <a href="/contests">戻る</a>');
        }

        const problemIndex = contest.problems.findIndex((p) => p.id === problemId);
        if (problemIndex === -1) {
            return res.status(404).send('無効な問題IDです');
        }

        const { content, score, writer, correctAnswer, image, explanation } = req.body;
        contest.problems[problemIndex] = {
            id: problemId,
            content: content || '',
            score: parseInt(score) || 100,
            writer: writer || '未設定',
            correctAnswer: correctAnswer || '',
            image: image || '',
            explanation: explanation || '',
        };

        await saveContests(contests);
        res.redirect(`/admin/problem/${contestId}/${problemId}`);
    } catch (err) {
        console.error('問題更新エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：問題画像アップロード
app.post('/admin/problem/:contestId/:problemId/upload', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user || !user.username) return res.redirect('/login');
        const contests = await loadContests();
        const contestId = parseInt(req.params.contestId);
        const problemId = req.params.problemId;

        if (isNaN(contestId) || contestId < 0 || contestId >= contests.length) {
            return res.status(404).send('無効なコンテストIDです');
        }

        const contest = contests[contestId];
        if (!canManageContest(user, contest)) {
            return res
                .status(403)
                .send('このコンテストを管理する権限がありません <a href="/contests">戻る</a>');
        }

        const problem = contest.problems.find((p) => p.id === problemId);
        if (!problem) {
            return res.status(404).send('無効な問題IDです');
        }

        if (!req.files || !req.files.image) {
            return res
                .status(400)
                .send('画像がアップロードされていません <a href="/admin/problem/' + contestId + '/' + problemId + '">戻る</a>');
        }

        const file = req.files.image;
        const uploadResult = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream(
                { resource_type: 'image' },
                (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                }
            ).end(file.data);
        });

        problem.image = uploadResult.secure_url;
        await saveContests(contests);
        res.redirect(`/admin/problem/${contestId}/${problemId}`);
    } catch (err) {
        console.error('画像アップロードエラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：ユーザー管理
app.get('/admin/users', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user || !user.username || !user.isAdmin) return res.redirect('/login');
        const users = await loadUsers();
        const nav = generateNav(user);
        const content = `
            <section class="hero">
                <h2>ユーザー管理</h2>
                <table class="user-table">
                    <tr><th>ユーザー名</th><th>管理者</th><th>操作</th></tr>
                    ${users
                        .map((u, index) => `
                            <tr>
                                <td>${u.username}</td>
                                <td>${u.isAdmin ? 'はい' : 'いいえ'}</td>
                                <td>
                                    <form action="/admin/toggle-admin" method="POST" style="display:inline;">
                                        <input type="hidden" name="index" value="${index}">
                                        <button type="submit">${u.isAdmin ? '管理者権限を剥奪' : '管理者にする'}</button>
                                    </form>
                                    <form action="/admin/delete-user" method="POST" style="display:inline;">
                                        <input type="hidden" name="index" value="${index}">
                                        <button type="submit">削除</button>
                                    </form>
                                </td>
                            </tr>
                        `).join('')}
                </table>
                <p><a href="/admin">管理者ダッシュボードに戻る</a></p>
            </section>
        `;
        res.send(generatePage(nav, content));
    } catch (err) {
        console.error('ユーザー管理エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：管理者権限の切り替え
app.post('/admin/toggle-admin', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user || !user.username || !user.isAdmin) return res.redirect('/login');
        const users = await loadUsers();
        const index = parseInt(req.body.index);

        if (isNaN(index) || index < 0 || index >= users.length) {
            return res.status(404).send('無効なユーザーインデックスです');
        }

        if (users[index].username === user.username) {
            return res.status(403).send('自分自身の管理者権限は変更できません <a href="/admin/users">戻る</a>');
        }

        users[index].isAdmin = !users[index].isAdmin;
        await saveUsers(users);
        res.redirect('/admin/users');
    } catch (err) {
        console.error('管理者権限切り替えエラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// ルート：ユーザー削除
app.post('/admin/delete-user', async (req, res) => {
    try {
        const user = await getUserFromCookie(req);
        if (!user || !user.username || !user.isAdmin) return res.redirect('/login');
        const users = await loadUsers();
        const index = parseInt(req.body.index);

        if (isNaN(index) || index < 0 || index >= users.length) {
            return res.status(404).send('無効なユーザーインデックスです');
        }

        if (users[index].username === user.username) {
            return res.status(403).send('自分自身を削除することはできません <a href="/admin/users">戻る</a>');
        }

        users.splice(index, 1);
        await saveUsers(users);
        res.redirect('/admin/users');
    } catch (err) {
        console.error('ユーザー削除エラー:', err);
        res.status(500).send("サーバーエラーが発生しました");
    }
});

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`サーバーがポート${PORT}で起動しました`);
    try {
        await connectToMongo();
        console.log('MongoDBに接続済み');
    } catch (err) {
        console.error('MongoDB接続に失敗しました:', err);
    }
});