const express = require('express');
const multer = require('multer');
const cors = require('cors');
const iconv = require('iconv-lite');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const metaDataFile = path.join(__dirname, 'meta-data.json');

// Настройка CORS
app.use(cors());

// Функция для генерации уникального имени файла
const generateUniqueFilename = (originalName) => {
    const ext = path.extname(originalName);
    const name = path.basename(originalName, ext);
    let uniqueName = originalName;
    let counter = 1;

    while (fs.existsSync(path.join(__dirname, 'storage', uniqueName))) {
        uniqueName = `${name}(${counter})${ext}`;
        counter++;
    }

    return uniqueName;
};

// Настройка хранилища для multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'storage/');
    },
    filename: (req, file, cb) => {
        // Конвертация имени файла в UTF-8
        const originalName = iconv.decode(Buffer.from(file.originalname, 'latin1'), 'utf-8');
        const uniqueName = generateUniqueFilename(originalName);
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

app.use(express.static('public'));

// Настройка статической директории для хранения файлов
app.use('/storage', express.static(path.join(__dirname, 'storage')));

// Функция для чтения метаданных из файла
const readMetaData = () => {
    try {
        if (!fs.existsSync(metaDataFile)) {
            fs.writeFileSync(metaDataFile, JSON.stringify([]));
        }
        const data = fs.readFileSync(metaDataFile, 'utf8');
        if (data.trim() === '') {
            return [];
        }
        return JSON.parse(data);
    } catch (error) {
        console.error('Ошибка при чтении метаданных:', error);
        // Инициализация файла с пустым массивом в случае ошибки
        fs.writeFileSync(metaDataFile, JSON.stringify([]));
        return [];
    }
};

// Функция для записи метаданных в файл
const writeMetaData = (data) => {
    try {
        fs.writeFileSync(metaDataFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error('Ошибка при записи метаданных:', error);
    }
};

// Маршрут для загрузки файлов
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('Файл не загружен');
    }

    const metaData = readMetaData();
    const newId = metaData.length ? metaData[metaData.length - 1].id + 1 : 1;
    const newFileMeta = {
        id: newId,
        author: req.body.username || 'guest',
        filename: req.file.filename,
        uploadDate: new Date().toISOString(),
        modifyDate: new Date().toISOString(),
        extension: path.extname(req.file.filename),
        size: (req.file.size / 1024).toFixed(2) + ' KB',
        state: 'Current',
        relatedFiles: []
    };

    metaData.push(newFileMeta);
    writeMetaData(metaData);

    res.json({ id: newId, filename: req.file.filename });
});

// Маршрут для получения списка файлов
app.get('/files', (req, res) => {
    const metaData = readMetaData();
    const files = metaData.filter(file => file.state === 'Current' && fs.existsSync(path.join(__dirname, 'storage', file.filename))).map(file => ({
        id: file.id,
        filename: file.filename
    }));
    res.json(files);
});

// Маршрут для удаления файлов (перемещение в корзину)
app.delete('/delete/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const metaData = readMetaData();
    const fileMeta = metaData.find(file => file.id === id);
    if (!fileMeta) {
        return res.status(404).send('Файл не найден');
    }

    const filename = fileMeta.filename;
    const filePath = path.join(__dirname, 'storage', filename);
    const date = new Date().toISOString().replace(/:/g, '-');
    const ext = path.extname(filename);
    const name = path.basename(filename, ext);
    const trashPath = path.join(__dirname, 'trash', `${name}-${date}${ext}`);

    fs.rename(filePath, trashPath, (err) => {
        if (err) {
            return res.status(500).send('Ошибка при перемещении файла в корзину');
        }

        // Обновление метаданных
        fileMeta.state = 'Deleted';
        fileMeta.modifyDate = new Date().toISOString();
        writeMetaData(metaData);

        res.sendStatus(200);
    });
});

// Маршрут для замены файлов
app.post('/replace', upload.single('file'), (req, res) => {
    const oldId = parseInt(req.body.oldId);
    const metaData = readMetaData();
    const oldFileMeta = metaData.find(file => file.id === oldId);
    const oldFilename = oldFileMeta.filename;
    const oldFilePath = path.join(__dirname, 'storage', oldFilename);
    const date = new Date().toISOString().replace(/:/g, '-');
    const ext = path.extname(oldFilename);
    const name = path.basename(oldFilename, ext);
    const trashPath = path.join(__dirname, 'trash', `${name}-${date}${ext}`);

    // Перемещение старого файла в корзину
    fs.rename(oldFilePath, trashPath, (err) => {
        if (err) {
            return res.status(500).send('Ошибка при перемещении старого файла в корзину');
        }

        // Обновление метаданных старого файла
        if (oldFileMeta) {
            oldFileMeta.state = 'Deleted';
            oldFileMeta.modifyDate = new Date().toISOString();
        }

        // Сохранение нового файла
        const newId = metaData.length ? metaData[metaData.length - 1].id + 1 : 1;
        const newFileMeta = {
            id: newId,
            author: oldFileMeta.author, // Подтягиваем автора из старого файла
            filename: req.file.filename,
            uploadDate: oldFileMeta.uploadDate, // Подтягиваем дату создания из старого файла
            modifyDate: new Date().toISOString(), // Обновляем дату изменения
            extension: path.extname(req.file.filename),
            size: (req.file.size / 1024).toFixed(2) + ' KB',
            state: 'Current',
            relatedFiles: oldFileMeta ? [oldFileMeta.id] : []
        };

        if (oldFileMeta) {
            oldFileMeta.relatedFiles.push(newFileMeta.id);
        }

        metaData.push(newFileMeta);
        writeMetaData(metaData);

        res.json({ id: newId, filename: req.file.filename, oldFilename: oldFilename });
    });
});



// Маршрут для проверки и реанимации файлов
app.post('/check-files', (req, res) => {
    const metaData = readMetaData();
    const storageDir = path.join(__dirname, 'storage');

    fs.readdir(storageDir, (err, files) => {
        if (err) {
            return res.status(500).send('Ошибка при чтении директории storage');
        }

        const fileNames = new Set(files);

        // Проверка на дубликаты в метаданных
        const duplicates = metaData.filter(file => file.state === 'Current');
        const uniqueFiles = new Map();

        duplicates.forEach(file => {
            if (uniqueFiles.has(file.filename)) {
                const existingFile = uniqueFiles.get(file.filename);
                if (file.id > existingFile.id) {
                    existingFile.state = 'Deleted';
                    uniqueFiles.set(file.filename, file);
                } else {
                    file.state = 'Deleted';
                }
            } else {
                uniqueFiles.set(file.filename, file);
            }
        });

        // Проверка на наличие файлов в storage
        metaData.forEach(file => {
            if (file.state === 'Current' && !fileNames.has(file.filename)) {
                file.state = 'Deleted';
                file.modifyDate = new Date().toISOString();
            }
        });

        // Реанимация файлов, отсутствующих в метаданных
        files.forEach(file => {
            const fileMeta = metaData.find(meta => meta.filename === file);
            if (!fileMeta) {
                const newId = metaData.length ? metaData[metaData.length - 1].id + 1 : 1;
                const newFileMeta = {
                    id: newId,
                    author: 'guest',
                    filename: file,
                    uploadDate: new Date().toISOString(),
                    modifyDate: new Date().toISOString(),
                    extension: path.extname(file),
                    size: (fs.statSync(path.join(storageDir, file)).size / 1024).toFixed(2) + ' KB',
                    state: 'Current',
                    relatedFiles: []
                };
                metaData.push(newFileMeta);
            }
        });

        writeMetaData(metaData);
        res.sendStatus(200);
    });
});


// Маршрут для опорожнения корзины
app.post('/empty-trash', (req, res) => {
    const metaData = readMetaData();
    const trashDir = path.join(__dirname, 'trash');

    // Удаление всех файлов из корзины
    fs.readdir(trashDir, (err, files) => {
        if (err) {
            return res.status(500).send('Ошибка при чтении директории корзины');
        }

        files.forEach(file => {
            const filePath = path.join(trashDir, file);
            fs.unlink(filePath, (err) => {
                if (err) {
                    console.error(`Ошибка при удалении файла ${filePath}:`, err);
                }
            });
        });

        // Обновление метаданных
        metaData.forEach(fileMeta => {
            if (fileMeta.state === 'Deleted') {
                fileMeta.state = 'Purged';
                fileMeta.modifyDate = new Date().toISOString();
            }
        });

        writeMetaData(metaData);
        res.sendStatus(200);
    });
});

// Маршрут для получения метаданных
app.get('/metadata', (req, res) => {
    const metaData = readMetaData();
    res.json(metaData);
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
});
