module.exports = {
    config: { name: "checkers", aliases: ['checkerboard'], version: "1.0", author: "Sheikh", countDown: 5, role: 0, category: "game", guide: "This command allows you to play Checkers. The game board is represented by a 6x5 grid where players take turns to move their pieces. To make a move, reply with the position number (1-5) followed by 'left' or 'right'. For example, '2 left' or '4 right'. The game ends when one player captures all of the opponent's pieces or when there are no valid moves left." },
    onStart: async function ({ event, message, usersData }) {
        const mention = Object.keys(event.mentions);
        if (event.args[0] == "close") {
            if (!global.game || !global.game[event.threadID] || global.game[event.threadID].on === false) {
                message.reply("There is no game running in this group");
            } else {
                if ([global.game[event.threadID].player1.id, global.game[event.threadID].player2.id].includes(event.senderID)) {
                    const winner = global.game[event.threadID].player1.id === event.senderID ? global.game[event.threadID].player2 : global.game[event.threadID].player1;
                    const loser = global.game[event.threadID].player1.id === event.senderID ? global.game[event.threadID].player1 : global.game[event.threadID].player2;
                    message.reply({ body: `What a cry baby. ${loser.name} left the game.\nWinner is ${winner.name}.`, mentions: [{ tag: loser.name, id: loser.id }, { tag: winner.name, id: winner.id }] });
                    global.game[event.threadID].on = false;
                } else {
                    message.reply("You don’t have any game running in this group");
                }
            }
        } else {
            if (mention.length === 0) {
                return message.reply("Please mention someone or say 'game close' to close any existing game");
            }
            if (!global.game || !global.game[event.threadID] || global.game[event.threadID].on === false) {
                global.game = global.game || {};
                global.game[event.threadID] = {
                    on: true,
                    board: "5⃣⬛3⃣⬛1⃣\n⬛4⃣⬛2⃣⬛\n⬛⬛⬛⬛⬛\n⬛⬛⬛⬛⬛\n⬛2⃣⬛4⃣⬛\n1⃣⬛3⃣⬛5⃣",
                    player1: { id: mention[0], name: await usersData.getName(mention[0]) },
                    player2: { id: event.senderID, name: await usersData.getName(event.senderID) },
                    turn: mention[0],
                };
                message.send(global.game[event.threadID].board, (err, info) => { global.game[event.threadID].bid = info.messageID; });
            } else {
                message.reply("A game is already on in this group");
            }
        }
    },
    onChat: async function ({ event, message }) {
        if (event.type === "message_reply" && global.game[event.threadID] && global.game[event.threadID].on) {
            if (event.messageReply.messageID === global.game[event.threadID].bid) {
                if (global.game[event.threadID].turn === event.senderID) {
                    const [position, direction] = event.body.toLowerCase().split(" ");
                    const newPosition = direction === "left" ? parseInt(position) - 1 : parseInt(position) + 1;
                    if (["left", "right"].includes(direction) && newPosition >= 1 && newPosition <= 5) {
                        global.game[event.threadID].board = swapPieces(global.game[event.threadID].board, parseInt(position), newPosition);
                        message.send(global.game[event.threadID].board);
                        global.game[event.threadID].turn = global.game[event.threadID].turn === global.game[event.threadID].player1.id ? global.game[event.threadID].player2.id : global.game[event.threadID].player1.id;
                    } else {
                        message.reply("Invalid move. Please specify 'left' or 'right' after the position number.");
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

function swapPieces(board, position, newPosition) {
    const rows = board.split("\n");
    const player1Piece = "🔴";
    const player2Piece = "🔵";
    const pieceToMove = rows[Math.floor((position - 1) / 2)][position * 2 - 2] === player1Piece ? player1Piece : player2Piece;
    if (rows[Math.floor((position - 1) / 2)][position * 2 - 2] !== "⬛" && rows[Math.floor((newPosition - 1) / 2)][newPosition * 2 - 2] === "⬛") {
        rows[Math.floor((newPosition - 1) / 2)] = rows[Math.floor((newPosition - 1) / 2)].substring(0, newPosition * 2 - 2) + pieceToMove + rows[Math.floor((newPosition - 1) / 2)].substring(newPosition * 2 - 1);
        rows[Math.floor((position - 1) / 2)] = rows[Math.floor((position - 1) / 2)].substring(0, position * 2 - 2) + "⬛" + rows[Math.floor((position - 1) / 2)].substring(position * 2 - 1);
        return rows.join("\n");
    } else {
        return board;
    }
                    }
