// game.js

// --- Configurações Globais do Jogo ---
const TILE_SIZE = 80;
const BOARD_SIZE = TILE_SIZE * 8;
const COLORS = [
    'rgb(240, 217, 181)', // Cor clara (bege)
    'rgb(181, 136, 99)'   // Cor escura (marrom)
];
const HIGHLIGHT_COLOR = 'rgba(246, 246, 105, 0.8)'; // Cor de destaque para seleção
const MOVE_CIRCLE_COLOR = 'rgba(100, 0, 100, 0.5)'; // Roxo escuro, translúcido para indicação de movimento

// --- Variáveis Globais para o Canvas e o Jogo ---
let canvas;
let ctx;
let pieceImages = {}; // Objeto para armazenar as imagens das peças já carregadas
let gameBoard;      // Instância do tabuleiro de xadrez da biblioteca chess.js

let selectedSquare = null;   // A casa que foi clicada e selecionada (ex: 'e2')
let possibleMoves = [];      // Array de casas para onde a peça selecionada pode mover

let websocket = null;        // Conexão WebSocket com o servidor
let myPlayerId = null;       // ID única deste jogador (gerada localmente)
let myGameId = "mychessgame"; // ID da sala do jogo (por padrão)
let myPlayerColor = null;    // Cor atribuída a este jogador pelo servidor ('white' ou 'black')
let gameStatusFromServer = "waiting"; // Armazena o status do jogo vindo do servidor
let isBoardFlipped = false;  // Controla se o tabuleiro deve ser invertido para o jogador

// --- Mapeamento de Símbolos de Peças para Caminhos de Imagem (ATUALIZADO COM /static/) ---
const PIECE_IMAGE_PATHS = {
    'r': '/static/images/black_r.png', 'n': '/static/images/black_n.png', 'b': '/static/images/black_b.png',
    'q': '/static/images/black_q.png', 'k': '/static/images/black_k.png', 'p': '/static/images/black_p.png',
    'R': '/static/images/white_r.png', 'N': '/static/images/white_n.png', 'B': '/static/images/white_b.png',
    'Q': '/static/images/white_q.png', 'K': '/static/images/white_k.png', 'P': '/static/images/white_p.png',
};

// --- Objeto para Funções Auxiliares de Conversão de Coordenadas (COM LÓGICA DE INVERSÃO) ---
const utils = {
    // Converte coordenadas de pixel do mouse para a notação de casa (ex: (0,0) -> 'a8')
    getSquareFromCoords: function(x, y) {
        let col = Math.floor(x / TILE_SIZE);
        let row = Math.floor(y / TILE_SIZE);
        
        // Se o tabuleiro estiver invertido, invertemos as coordenadas de linha/coluna
        // para obter a casa correta do chess.js (sempre a8-h1).
        if (isBoardFlipped) {
            col = 7 - col;
            row = 7 - row;
        }

        const fileChar = String.fromCharCode('a'.charCodeAt(0) + col);
        const rankNum = 8 - row; 
        return fileChar + rankNum;
    },

    // Converte notação de casa para coordenadas de pixel do canto superior esquerdo (ex: 'a8' -> (0,0))
    // Considera a inversão visual do tabuleiro.
    getCoordsFromSquareName: function(squareName) {
        const fileChar = squareName.charCodeAt(0);
        const rankNum = parseInt(squareName[1]);

        let col = fileChar - 'a'.charCodeAt(0);
        let row = 8 - rankNum;

        // Se o tabuleiro estiver invertido, invertemos as coordenadas de linha/coluna
        // para a exibição visual.
        if (isBoardFlipped) {
            col = 7 - col;
            row = 7 - row;
        }

        return { x: col * TILE_SIZE, y: row * TILE_SIZE };
    }
};

// --- Funções de Desenho ---
function drawGame() {
    ctx.clearRect(0, 0, BOARD_SIZE, BOARD_SIZE);
    drawBoard();
    drawHighlights();
    drawPieces();
}

function drawBoard() {
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const colorIndex = (row + col) % 2;
            const color = COLORS[colorIndex];
            ctx.fillStyle = color;
            
            // Inverte a posição visual da linha/coluna se o tabuleiro estiver invertido
            const displayCol = isBoardFlipped ? (7 - col) : col;
            const displayRow = isBoardFlipped ? (7 - row) : row;

            const x = displayCol * TILE_SIZE;
            const y = displayRow * TILE_SIZE;
            ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
        }
    }
}

function drawHighlights() {
    if (selectedSquare) {
        const coords = utils.getCoordsFromSquareName(selectedSquare);
        ctx.fillStyle = HIGHLIGHT_COLOR;
        ctx.fillRect(coords.x, coords.y, TILE_SIZE, TILE_SIZE);
    }

    for (const move of possibleMoves) {
        const coords = utils.getCoordsFromSquareName(move.to);
        const centerX = coords.x + TILE_SIZE / 2;
        const centerY = coords.y + TILE_SIZE / 2;
        ctx.fillStyle = MOVE_CIRCLE_COLOR;
        ctx.beginPath();
        ctx.arc(centerX, centerY, TILE_SIZE / 6, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawPieces() {
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            // Obtenha o nome da casa na notação padrão (a8-h1)
            const squareName = String.fromCharCode('a'.charCodeAt(0) + col) + (8 - row);
            
            const piece = gameBoard.get(squareName);

            if (piece) {
                const pieceSymbol = piece.color === 'w' ? piece.type.toUpperCase() : piece.type.toLowerCase();
                const img = pieceImages[pieceSymbol];

                // Calcule as coordenadas de exibição (x, y) com base na inversão do tabuleiro
                const coords = utils.getCoordsFromSquareName(squareName); // Usa utils para obter as coordenadas visuais corretas

                if (img && img.complete && img.naturalWidth > 0) {
                    ctx.drawImage(img, coords.x, coords.y, TILE_SIZE, TILE_SIZE);
                } else {
                    console.warn(`drawPieces: Imagem para ${pieceSymbol} (caminho: ${PIECE_IMAGE_PATHS[pieceSymbol]}) não carregada ou inválida na casa ${squareName}.`);
                }
            }
        }
    }
}

// --- Lógica de Interatividade e Comunicação WebSocket ---
async function handleMouseDown(event) {
    const mouseX = event.offsetX;
    const mouseY = event.offsetY;
    const clickedSquare = utils.getSquareFromCoords(mouseX, mouseY);
    
    if (gameStatusFromServer !== "playing") { 
        console.log("Jogo não está no estado 'playing'. Não é possível mover peças.");
        return;
    }

    const pieceAtClickedSquare = gameBoard.get(clickedSquare);

    if (selectedSquare === null) {
        // Seleciona uma peça se for do seu turno
        if (pieceAtClickedSquare && 
            ((myPlayerColor === 'white' && gameBoard.turn() === 'w') || 
             (myPlayerColor === 'black' && gameBoard.turn() === 'b'))) {
            selectedSquare = clickedSquare;
            possibleMoves = gameBoard.moves({ square: selectedSquare, verbose: true });
            drawGame();
        } else {
            console.log("Nenhuma peça válida selecionada ou não é o seu turno.");
        }
    } else {
        // Tenta mover para a casa clicada
        if (clickedSquare === selectedSquare) {
            selectedSquare = null;
            possibleMoves = [];
            drawGame();
            return;
        }

        const isLegalMove = possibleMoves.some(move => move.to === clickedSquare);

        if (isLegalMove) {
            const moveData = {
                from: selectedSquare,
                to: clickedSquare,
                promotion: null 
            };

            const piece = gameBoard.get(selectedSquare);
            if (piece && piece.type === 'p') {
                const targetRankForPromotion = (myPlayerColor === 'white') ? 8 : 1;
                const clickedRank = parseInt(clickedSquare[1]);

                if (clickedRank === targetRankForPromotion) {
                    let promotionChoice = prompt("Promover para (q/r/b/n)?").toLowerCase();
                    while (!['q', 'r', 'b', 'n'].includes(promotionChoice)) {
                        promotionChoice = prompt("Escolha inválida. Promover para (q/r/b/n)?").toLowerCase();
                    }
                    moveData.promotion = promotionChoice;
                }
            }
            
            if (websocket && websocket.readyState === WebSocket.OPEN) {
                websocket.send(JSON.stringify({
                    type: "make_move",
                    data: {
                        game_id: myGameId,
                        player_id: myPlayerId,
                        move: moveData
                    }
                }));
            } else {
                console.error("WebSocket não está conectado.");
            }
            
            selectedSquare = null;
            possibleMoves = [];
            drawGame(); 
        } else {
            if (pieceAtClickedSquare && 
                ((myPlayerColor === 'white' && gameBoard.turn() === 'w') || 
                 (myPlayerColor === 'black' && gameBoard.turn() === 'b')) &&
                clickedSquare !== selectedSquare) { 
                selectedSquare = clickedSquare;
                possibleMoves = gameBoard.moves({ square: selectedSquare, verbose: true });
                drawGame();
            } else {
                selectedSquare = null;
                possibleMoves = [];
                drawGame();
            }
        }
    }
}

// --- Gerenciamento do Log de Movimentos e Status ---
function updateMoveLog(sanMove, currentTurn) { 
    const moveLogElement = document.getElementById('moveLog');
    
    const totalMovesMade = gameBoard.history().length;
    const moveNumber = Math.ceil(totalMovesMade / 2);
    const isWhiteMoveCompleted = totalMovesMade % 2 !== 0; 

    let currentMoveListItem;
    if (isWhiteMoveCompleted) { 
        currentMoveListItem = document.createElement('li');
        currentMoveListItem.innerHTML = `<span class="font-bold">Lance ${moveNumber}.</span> ${sanMove}`;
        moveLogElement.appendChild(currentMoveListItem);
    } else { 
        currentMoveListItem = moveLogElement.lastChild;
        if (currentMoveListItem) {
            currentMoveListItem.innerHTML += ` ${sanMove}`;
        } else {
            currentMoveListItem = document.createElement('li');
            currentMoveListItem.innerHTML = `<span class="font-bold">Lance ${moveNumber}.</span> ... ${sanMove}`; 
            moveLogElement.appendChild(currentMoveListItem);
        }
    }
    moveLogElement.scrollTop = moveLogElement.scrollHeight;
}

function updateGameStatus(status, turn, whiteId, blackId) {
    const statusElement = document.getElementById('gameStatus');
    let statusText = "";

    switch(status) {
        case "waiting":
            statusText = `Aguardando jogadores... (${whiteId ? 'Brancas prontas' : ''} ${blackId ? 'Pretas prontas' : ''})`;
            break;
        case "playing":
            const turnColor = turn === 'w' ? 'Brancas' : 'Pretas';
            const yourTurn = (turn === 'w' && myPlayerColor === 'white') || (turn === 'b' && myPlayerColor === 'black');
            statusText = `Turno: ${turnColor} ${yourTurn ? '(Sua vez)' : ''}`;
            break;
        case "finished":
            statusText = "Jogo Finalizado!";
            break;
        default:
            statusText = "Status desconhecido.";
    }
    statusElement.textContent = statusText;
}

// --- Funções para Botões de Ação (Desistir, Empate) ---
function setupActionButtons() {
    document.getElementById('resignButton').addEventListener('click', () => {
        if (websocket && websocket.readyState === WebSocket.OPEN && myGameId) {
            websocket.send(JSON.stringify({
                type: "resign",
                data: {
                    game_id: myGameId,
                    player_id: myPlayerId,
                    color: myPlayerColor
                }
            }));
            alert("Você desistiu do jogo.");
        }
    });

    document.getElementById('drawButton').addEventListener('click', () => {
        if (websocket && websocket.readyState === WebSocket.OPEN && myGameId) {
            websocket.send(JSON.stringify({
                type: "propose_draw",
                data: {
                    game_id: myGameId,
                    player_id: myPlayerId,
                    color: myPlayerColor
                }
            }));
            alert("Você propôs um empate.");
        }
    });
}

// --- Função para Gerenciar o Fim do Jogo ---
function handleGameOver(reason, winner) {
    let message = "";
    if (reason === "checkmate") {
        const winnerText = winner === 'white' ? 'Brancas' : 'Pretas';
        message = `XEQUE-MATE! ${winnerText} ganharam!`;
    } else if (reason === "stalemate") {
        message = "EMPATE por afogamento!";
    } else if (reason === "insufficient_material") {
        message = "EMPATE por material insuficiente!";
    } else if (reason === "draw") { 
        message = "EMPATE!";
    } else if (reason === "opponent_disconnected") {
        const winnerText = winner === 'white' ? 'Brancas' : 'Pretas';
        message = `${winnerText} ganharam por desconexão do oponente!`;
    } else {
        message = "Jogo Finalizado!";
    }
    alert(message); 
}


// --- Função de Inicialização do Frontend (chamada ao carregar a página) ---
async function initFrontend() {
    gameBoard = new Chess(); 

    canvas = document.getElementById('chessBoard');
    ctx = canvas.getContext('2d');

    canvas.width = BOARD_SIZE;
    canvas.height = BOARD_SIZE;

    myPlayerId = crypto.randomUUID();
    document.getElementById('playerIdDisplay').textContent = `Seu ID: ${myPlayerId}`;

    setupActionButtons();

    try {
        await loadPieceImages();
        drawGame(); 
    } catch (error) {
        console.error("Não foi possível carregar as imagens das peças. O jogo não será renderizado corretamente.", error);
        ctx.fillStyle = 'red';
        ctx.font = '20px Arial';
        ctx.fillText("Erro ao carregar imagens. Verifique o console.", 50, BOARD_SIZE / 2);
        return;
    }

    const gameIdInput = document.getElementById('gameIdInput');
    gameIdInput.value = myGameId; 

    const joinGameButton = document.getElementById('joinGameButton');
    joinGameButton.addEventListener('click', () => {
        myGameId = gameIdInput.value;
        if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.close(); 
        }
        connectWebSocket();
    });

    connectWebSocket(); 

    canvas.addEventListener('mousedown', handleMouseDown);
}

// --- Função para Conectar ao Servidor WebSocket (ATUALIZADA COM URL DO RENDER) ---
function connectWebSocket() {
    if (websocket) {
        if (websocket.readyState === WebSocket.OPEN) {
            console.log("WebSocket já está conectado.");
            return;
        }
        if (websocket.readyState === WebSocket.CLOSING || websocket.readyState === WebSocket.CLOSED) {
            websocket = null;
        }
    }

    // ATENÇÃO: Use a URL do seu serviço Render aqui, com "wss://" e "/ws"
    websocket = new WebSocket("wss://chess-websocket-1-hi9e.onrender.com/ws");

    websocket.onopen = function(event) {
        console.log("Conectado ao servidor WebSocket.");
        websocket.send(JSON.stringify({
            type: "join_game",
            data: {
                game_id: myGameId,
                player_id: myPlayerId
            }
        }));
        document.getElementById('connectionStatus').textContent = 'Status da Conexão: Conectado!';
        document.getElementById('connectionStatus').classList.remove('bg-red-100', 'text-red-800');
        document.getElementById('connectionStatus').classList.add('bg-green-100', 'text-green-800');
    };

    websocket.onmessage = function(event) {
        const message = JSON.parse(event.data);
        console.log("Mensagem recebida do servidor:", message);

        switch (message.type) {
            case "player_color":
                myPlayerColor = message.color;
                isBoardFlipped = (myPlayerColor === 'black'); // Inverte o tabuleiro se o jogador for PRETAS
                document.getElementById('playerColorDisplay').textContent = `Você é: ${myPlayerColor.toUpperCase()}`;
                console.log(`Você foi atribuído como jogador ${myPlayerColor.toUpperCase()}. Tabuleiro invertido: ${isBoardFlipped}`);
                drawGame(); // Redesenha para aplicar a orientação correta assim que a cor é atribuída
                break;
            case "game_state":
                gameBoard.load(message.data.fen);
                gameStatusFromServer = message.data.status; 
                
                const frontendTurn = message.data.turn === true ? 'w' : 'b'; 
                
                updateGameStatus(message.data.status, frontendTurn, message.data.white_player_id, message.data.black_player_id);
                
                document.getElementById('moveLog').innerHTML = ''; 
                if (message.data.move_history) {
                    message.data.move_history.forEach((move, index) => {
                        const moveNumber = Math.ceil((index + 1) / 2);
                        const isWhiteMove = (index + 1) % 2 !== 0; 
                        
                        let currentMoveListItem;
                        if (isWhiteMove) {
                            currentMoveListItem = document.createElement('li');
                            currentMoveListItem.innerHTML = `<span class="font-bold">Lance ${moveNumber}.</span> ${move}`;
                            document.getElementById('moveLog').appendChild(currentMoveListItem);
                        } else {
                            currentMoveListItem = document.getElementById('moveLog').lastChild;
                            if (currentMoveListItem) {
                                currentMoveListItem.innerHTML += ` ${move}`;
                            } else {
                                currentMoveListItem = document.createElement('li');
                                currentMoveListItem.innerHTML = `<span class="font-bold">Lance ${moveNumber}.</span> ... ${move}`;
                                document.getElementById('moveLog').appendChild(currentMoveListItem);
                            }
                        }
                    });
                    document.getElementById('moveLog').scrollTop = document.getElementById('moveLog').scrollHeight;
                }
                drawGame(); 
                break;
            case "game_over":
                handleGameOver(message.data.reason, message.data.winner);
                gameStatusFromServer = "finished"; 
                updateGameStatus("finished", null, null, null); 
                break;
            case "error":
                alert("Erro do servidor: " + message.message);
                console.error("Erro do servidor:", message.message);
                break;
            default:
                console.warn("Tipo de mensagem desconhecido:", message.type);
        }
    };

    websocket.onclose = function(event) {
        console.log("Desconectado do servidor WebSocket.", event);
        document.getElementById('connectionStatus').textContent = 'Status da Conexão: Desconectado';
        document.getElementById('connectionStatus').classList.remove('bg-green-100', 'text-green-800');
        document.getElementById('connectionStatus').classList.add('bg-red-100', 'text-red-800');
        gameStatusFromServer = "disconnected"; 
        updateGameStatus("disconnected", null, null, null); 
    };

    websocket.onerror = function(event) {
        console.error("Erro no WebSocket:", event);
        document.getElementById('connectionStatus').textContent = 'Status da Conexão: Erro!';
        document.getElementById('connectionStatus').classList.remove('bg-green-100', 'text-red-800');
        document.getElementById('connectionStatus').classList.add('bg-red-100', 'text-red-800');
        gameStatusFromServer = "error"; 
    };
}

// --- Event Listener para Iniciar o Frontend ---
window.onload = initFrontend;
