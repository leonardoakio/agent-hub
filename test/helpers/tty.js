'use strict';
// Pré-carregado nos testes (node -r): faz a interface se comportar como num terminal, para a lista de atividade
// (os registros de event()) sair no stdout e poder ser conferida.
Object.defineProperty(process.stdout, 'isTTY', { value: true });
