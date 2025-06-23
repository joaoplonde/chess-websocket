# main.py - Servidor Backend para o Jogo de Xadrez Multiplayer

import asyncio
import websockets
import json
import collections
import logging
import os # Importe a biblioteca os
from dotenv import load_dotenv # Para carregar variáveis de ambiente do arquivo .env
import chess # Importa a biblioteca python-chess

# Configuração de Log para o servidor
logging.basicConfig(level=logging.INFO)

# Carrega variáveis de ambiente do arquivo .env (se houver)
load_dotenv()

# --- Estruturas de Dados Globais para Gerenciar Jogos ---
# Representa um jogo de xadrez: tabuleiro, jogadores conectados, etc.
# Usamos defaultdict para criar novas entradas de jogo automaticamente
# quando uma nova ID de jogo é acessada.
GAMES = collections.defaultdict(
    lambda: {
        "board": chess.Board(),  # Um novo tabuleiro para cada jogo
        "players": collections.defaultdict(lambda: {"websocket": None, "id": None}),
        "player_count": 0,
        "next_player_color": 'white', # Para controlar quem será o próximo a entrar
        "status": "waiting", # "waiting", "playing", "finished"
        "move_history": []
    }
)

# Set para rastrear todos os WebSockets ativos para evitar duplicações
CONNECTED_CLIENTS = set()

# --- Funções Auxiliares ---

# Função para enviar uma mensagem para um cliente WebSocket específico
async def send_message(websocket, message):
    try:
        await websocket.send(json.dumps(message))
    except websockets.exceptions.ConnectionClosedOK:
        logging.info("WebSocket fechado ao tentar enviar mensagem.")
    except Exception as e:
        logging.error(f"Erro ao enviar mensagem: {e}")

# Função para transmitir uma mensagem para todos os jogadores em um jogo
async def broadcast_game_state(game_id, message_type, data):
    game = GAMES[game_id]
    message = {
        "type": message_type,
        "data": data
    }
    
    # Envia a mensagem para as Brancas
    if game["players"]["white"]["websocket"]:
        await send_message(game["players"]["white"]["websocket"], message)
    # Envia a mensagem para as Pretas
    if game["players"]["black"]["websocket"]:
        await send_message(game["players"]["black"]["websocket"], message)
    
    logging.info(f"Mensagem '{message_type}' transmitida para o jogo {game_id}")

# --- Handlers para Mensagens Recebidas ---

# Processa mensagens de "join_game"
async def handle_join_game(websocket, message_data):
    game_id = message_data.get("game_id")
    player_id = message_data.get("player_id") # Um ID único para cada cliente
    
    if not game_id or not player_id:
        logging.warning("join_game: game_id ou player_id faltando.")
        await send_message(websocket, {"type": "error", "message": "ID do jogo ou do jogador faltando."})
        return

    game = GAMES[game_id]
    
    # Garante que o jogador não esteja já conectado na mesma cor ou em outra cor
    if game["players"]["white"]["id"] == player_id or game["players"]["black"]["id"] == player_id:
        logging.info(f"Jogador {player_id} já está conectado ao jogo {game_id}.")
        # Re-enviar o estado atual para o jogador que reconectou
        await broadcast_game_state(game_id, "game_state", {
            "fen": game["board"].fen(),
            "turn": game["board"].turn, 
            "status": game["status"],
            "white_player_id": game["players"]["white"]["id"],
            "black_player_id": game["players"]["black"]["id"],
            "move_history": game["move_history"]
        })
        return

    # Atribui uma cor ao jogador que está entrando
    assigned_color = None
    if game["players"]["white"]["websocket"] is None:
        game["players"]["white"]["websocket"] = websocket
        game["players"]["white"]["id"] = player_id
        assigned_color = 'white'
        game["player_count"] += 1
        logging.info(f"Jogador {player_id} conectado como BRANCAS no jogo {game_id}.")
    elif game["players"]["black"]["websocket"] is None:
        game["players"]["black"]["websocket"] = websocket
        game["players"]["black"]["id"] = player_id
        assigned_color = 'black'
        game["player_count"] += 1
        logging.info(f"Jogador {player_id} conectado como PRETAS no jogo {game_id}.")
    else:
        logging.warning(f"Jogo {game_id} cheio. Jogador {player_id} não pode entrar.")
        await send_message(websocket, {"type": "error", "message": "O jogo está cheio."})
        return

    # Se 2 jogadores conectados, o jogo pode começar
    if game["player_count"] == 2 and game["status"] == "waiting":
        game["status"] = "playing"
        logging.info(f"Jogo {game_id} agora está JOGANDO.")
    
    # Envia a cor atribuída de volta ao cliente
    await send_message(websocket, {"type": "player_color", "color": assigned_color})

    # Transmite o estado atual do jogo para todos os jogadores do jogo
    await broadcast_game_state(game_id, "game_state", {
        "fen": game["board"].fen(),
        "turn": game["board"].turn,
        "status": game["status"],
        "white_player_id": game["players"]["white"]["id"],
        "black_player_id": game["players"]["black"]["id"],
        "move_history": game["move_history"]
    })

# Processa mensagens de "make_move"
async def handle_make_move(websocket, message_data):
    game_id = message_data.get("game_id")
    player_id = message_data.get("player_id")
    move = message_data.get("move") 

    if not game_id or not player_id or not move:
        logging.warning("make_move: Dados faltando.")
        await send_message(websocket, {"type": "error", "message": "Dados do movimento faltando."})
        return

    game = GAMES[game_id]
    board = game["board"]

    expected_turn_color_str = 'white' if board.turn == chess.WHITE else 'black'
    current_player_assigned_color = None
    if game["players"]["white"]["id"] == player_id:
        current_player_assigned_color = 'white'
    elif game["players"]["black"]["id"] == player_id:
        current_player_assigned_color = 'black'

    if current_player_assigned_color != expected_turn_color_str:
        logging.warning(f"Não é a vez do jogador {player_id} ({current_player_assigned_color}) no jogo {game_id}. Turno esperado: {expected_turn_color_str}.")
        await send_message(websocket, {"type": "error", "message": "Não é o seu turno."})
        return

    try:
        uci_move = f"{move['from']}{move['to']}"
        
        if 'promotion' in move and move['promotion']:
            uci_move += move['promotion']
        
        logging.info(f"Tentando mover UCI: {uci_move} para o jogo {game_id}")

        chess_move = chess.Move.from_uci(uci_move)
        
        logging.info(f"Movimento UCI recebido: {chess_move.uci()}")
        logging.info(f"Movimentos legais atuais no tabuleiro: {[m.uci() for m in board.legal_moves]}")


        if chess_move in board.legal_moves:
            san_move = board.san(chess_move)
            
            board.push(chess_move) 
            
            logging.info(f"Movimento legal feito no jogo {game_id}: {san_move}")
            game["move_history"].append(san_move) 

            await broadcast_game_state(game_id, "game_state", {
                "fen": board.fen(),
                "turn": board.turn, 
                "status": game["status"], 
                "white_player_id": game["players"]["white"]["id"],
                "black_player_id": game["players"]["black"]["id"],
                "move_history": game["move_history"]
            })
            
            if board.is_checkmate():
                game["status"] = "finished"
                await broadcast_game_state(game_id, "game_over", {"reason": "checkmate", "winner": expected_turn_color_str}) 
                logging.info(f"Jogo {game_id} terminou em XEQUE-MATE.")
            elif board.is_stalemate():
                game["status"] = "finished"
                await broadcast_game_state(game_id, "game_over", {"reason": "stalemate"})
                logging.info(f"Jogo {game_id} terminou em AFOGAMENTO.")
            elif board.is_insufficient_material():
                game["status"] = "finished"
                await broadcast_game_state(game_id, "game_over", {"reason": "insufficient_material"})
                logging.info(f"Jogo {game_id} terminou por MATERIAL INSUFICIENTE.")
            elif board.is_fivefold_repetition() or board.is_seventyfive_moves(): 
                game["status"] = "finished"
                await broadcast_game_state(game_id, "game_over", {"reason": "draw"})
                logging.info(f"Jogo {game_id} terminou em EMPATE.")


        else:
            logging.warning(f"Movimento ilegal tentado no jogo {game_id}: {uci_move}. Não está na lista de lances legais.")
            await send_message(websocket, {"type": "error", "message": "Movimento ilegal."})

    except ValueError as e:
        logging.error(f"Erro de formato de movimento UCI para '{uci_move}': {e}", exc_info=True) 
        await send_message(websocket, {"type": "error", "message": f"Formato de movimento inválido: {e}"})
    except Exception as e:
        logging.error(f"Erro inesperado ao fazer movimento no jogo {game_id}: {e}", exc_info=True) 
        await send_message(websocket, {"type": "error", "message": "Erro interno ao processar movimento."})


# --- Lógica Principal do Manipulador de Conexões WebSocket ---
async def handler(websocket): 
    CONNECTED_CLIENTS.add(websocket)
    logging.info(f"Novo cliente conectado: {websocket.remote_address}")

    game_id = None 

    try:
        async for message in websocket:
            try:
                data = json.loads(message)
                message_type = data.get("type")
                message_data = data.get("data")
                
                if message_type == "join_game":
                    game_id = message_data.get("game_id")
                    await handle_join_game(websocket, message_data)
                elif message_type == "make_move":
                    await handle_make_move(websocket, message_data)
                else:
                    logging.warning(f"Tipo de mensagem desconhecido: {message_type}")
                    await send_message(websocket, {"type": "error", "message": "Tipo de mensagem desconhecido."})

            except json.JSONDecodeError:
                logging.error(f"Mensagem JSON inválida recebida: {message}")
                await send_message(websocket, {"type": "error", "message": "Formato de mensagem JSON inválido."})
            except Exception as e:
                logging.error(f"Erro ao processar mensagem: {e}")
                await send_message(websocket, {"type": "error", "message": "Erro interno do servidor."})
    finally:
        CONNECTED_CLIENTS.discard(websocket)
        logging.info(f"Cliente desconectado: {websocket.remote_address}")

        if game_id:
            game = GAMES[game_id]
            disconnected_color = None
            if game["players"]["white"]["websocket"] == websocket:
                game["players"]["white"]["websocket"] = None
                game["players"]["white"]["id"] = None
                disconnected_color = 'white'
            elif game["players"]["black"]["websocket"] == websocket:
                game["players"]["black"]["websocket"] = None
                game["players"]["black"]["id"] = None
                disconnected_color = 'black'
            
            if disconnected_color:
                game["player_count"] -= 1
                logging.info(f"Jogador '{disconnected_color}' desconectado do jogo {game_id}. Jogadores restantes: {game['player_count']}")
                if game["status"] == "playing" and game["player_count"] < 2:
                    game["status"] = "finished"
                    winner_color = 'black' if disconnected_color == 'white' else 'white'
                    if winner_color == 'white' and game["players"]["white"]["websocket"]:
                        await send_message(game["players"]["white"]["websocket"], {"type": "game_over", "reason": "opponent_disconnected", "winner": winner_color})
                    elif winner_color == 'black' and game["players"]["black"]["websocket"]:
                        await send_message(game["players"]["black"]["websocket"], {"type": "game_over", "reason": "opponent_disconnected", "winner": winner_color})
                    logging.info(f"Jogo {game_id} terminou: {winner_color} venceu por desconexão.")
                
                if game["player_count"] == 0:
                    del GAMES[game_id]
                    logging.info(f"Jogo {game_id} removido por falta de jogadores.")


# --- Função Principal para Iniciar o Servidor ---
async def main():
    # Obtém a porta do ambiente (Render define a variável PORT)
    # Se não estiver no Render, usa 8765 como fallback para testes locais
    port = int(os.environ.get("PORT", 8765)) 
    logging.info(f"Servidor WebSocket iniciando na porta {port}...")
    async with websockets.serve(handler, "0.0.0.0", port): # Usa a porta dinâmica aqui
        await asyncio.Future()  

if __name__ == "__main__":
    asyncio.run(main())
