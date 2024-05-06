module.exports = {
    config: {
        name: "checkers",
        aliases: ['checkerboard'],
        version: "1.2",
        author: "Sheikh",
        countdown: 5,
        role: 0,
        category: "game",
        guide: "This command allows you to play Checkers. The game board is represented by a 6x5 grid where players take turns to move their pieces. To make a move, reply with the position number (1-5) followed by 'left' or 'right'. For example, '2 left' or '4 right'. The game ends when one player captures all of the opponent's pieces or when there are no valid moves left.",
    },
    onStart: async function ({ event, message, usersData, args }) {
        const mention = Object.keys(event.mentions);
        if (args[0] === "close") {
            // Close the game
            if (!global.game || !global.game[event.threadID] || global.game[event.threadID].on === false) {
                return message.reply("There is no game running in this group");
            }
            if (event.senderID === global.game[event.threadID].player1.id || event.senderID === global.game[event.threadID].player2.id) {
                const winner = event.senderID === global.game[event.threadID].player1.id ? global.game[event.threadID].player2 : global.game[event.threadID].player1;
                const loser = event.senderID === global.game[event.threadID].player1.id ? global.game[event.threadID].player1 : global.game[event.threadID].player2;
                message.reply({
                    body: `What a cry baby. ${loser.name} left the game.\nWinner is ${winner.name}.`,
                    mentions: [{ tag: loser.name, id: loser.id }, { tag: winner.name, id: winner.id }]
                });
                delete global.game[event.threadID];
            } else {
                message.reply("You don’t have any game running in this group");
            }
        } else {
            // Start a new game
            if (mention.length === 0) {
                return message.reply("Please mention someone or say 'game close' to close any existing game");
            }
            if (!global.game || !global.game[event.threadID] || global.game[event.threadID].on === false) {
                if (!global.game) {
                    global.game = {};
                }
                global.game[event.threadID] = {
                    on: true,
                    board: "🔴⬛🔴⬛🔴\n⬛🔴⬛🔴⬛\n⬛⬛⬛⬛⬛\n⬛⬛⬛⬛⬛\n⬛🔵⬛🔵⬛\n🔵⬛🔵⬛🔵",
                    player1: { id: mention[0], name: await usersData.getName(mention[0]) },
                    player2: { id: event.senderID, name: await usersData.getName(event.senderID) },
                    turn: mention[0], // Starting player
                };
                message.send(global.game[event.threadID].board, (err, info) => { global.game[event.threadID].bid = info.messageID; });
            } else {
                message.reply("A game is already on in this group");
            }
        }
    },
    onChat: async function ({ event, message }) {
        if (event.type === "message_reply" && global.game[event.threadID] && global.game[event.threadID].on === true) {
            if (event.messageReply.messageID === global.game[event.threadID].bid) {
                if (global.game[event.threadID].turn === event.senderID) {
                    const move = event.body.toLowerCase();
                    const match = move.match(/^(\d) (left|right)$/);
                    if (match) {
                        const position = parseInt(match[1]);
                        const direction = match[2];
                        if (position >= 1 && position <= 5) {
                            const validMove = isValidMove(global.game[event.threadID].board, position, direction, global.game[event.threadID].turn === global.game[event.threadID].player1.id ? "🔴" : "🔵");
                            if (validMove) {
                                global.game[event.threadID].board = makeMove(global.game[event.threadID].board, position, direction);
                                message.send(global.game[event.threadID].board);
                                global.game[event.threadID].turn = global.game[event.threadID].turn === global.game[event.threadID].player1.id ? global.game[event.threadID].player2.id : global.game[event.threadID].player1.id;
                            } else {
                                message.reply("Invalid move. Please make a valid move.");
                            }
                        } else {
                            message.reply("Invalid position. Please specify a position between 1 and 5.");
                        }
                    } else {
                        message.reply("Invalid move format. Please reply with the position number (1-5) followed by 'left' or 'right'.");
                    }
                } else {
                    message.reply("Not your turn.");
                }
            } else {
                message.reply("Please reply with a valid move.");
            }
        }
    }
};

function isValidMove(board, position, direction, playerPiece) {
    const rows = board.split("\n");
    const rowIndex = Math.floor((position - 1) / 2) * 2; // Get the index of the row containing the piece to be moved
    const pieceIndex = (position - 1) % 2 * 2 + (direction === "left" ? 0 : 1); // Get the index of the piece in the row
    const piece = rows[rowIndex].charAt(pieceIndex);
    if (playerPiece === "🔴") {
        if (piece === "🔴") {
            // Check if the move is valid for red player
            if (direction === "left" && pieceIndex > 0 && rows[rowIndex + 1].charAt(pieceIndex - 1) === "⬛") {
                return true;
            } else if (direction === "right" && pieceIndex < 4 && rows[rowIndex + 1].charAt(pieceIndex + 1) === "⬛") {
                return true;
            }
        }
    } else if (playerPiece === "🔵") {
        if (piece === "🔵") {
            // Check if the move is valid for blue player
            if (direction === "left" && pieceIndex > 0 && rows[rowIndex - 1].charAt(pieceIndex - 1) === "⬛") {
                return true;
            } else if (direction === "right" && pieceIndex < 4 && rows[rowIndex - 1].charAt(pieceIndex + 1) === "⬛") {
                return true;
            }
        }
    }
    return false;
} function makeMove(board, position, direction) {
    const rows = board.split("\n");
    const rowIndex = Math.floor((position - 1) / 2) * 2;
    const pieceIndex = (position - 1) % 2 * 2 + (direction === "left" ? 0 : 1);
    const playerPiece = direction === "left" ? "⬛" : "🔴";

    // Update the board with the new move
    rows[rowIndex] = rows[rowIndex].substring(0, pieceIndex) + playerPiece + rows[rowIndex].substring(pieceIndex + 1);

    // Clear the previous position
    const previousPieceIndex = direction === "left" ? pieceIndex + 1 : pieceIndex - 1;
    rows[rowIndex] = rows[rowIndex].substring(0, previousPieceIndex) + "⬛" + rows[rowIndex].substring(previousPieceIndex + 1);

    return rows.join("\n");
}

