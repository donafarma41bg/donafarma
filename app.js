// ===================================================================
// SISTEMA DE ATENDIMENTO WHATSAPP - DROGARIA DONA FARMA
// Versão: 2.2 - CORREÇÕES IMPLEMENTADAS
// Desenvolvido para: Sistema brasileiro de celulares
// Ambiente: Oracle Ubuntu 1GB RAM
// Preparado para: Integração HubSpot
// ===================================================================

// SEÇÃO 1: IMPORTS E DEPENDÊNCIAS
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');

// SEÇÃO 2: CONFIGURAÇÃO DO SERVIDOR
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// SEÇÃO 3: CONFIGURAÇÃO DE SESSÃO PARA PAINEL WEB
app.use(session({
  secret: 'donafarma_secret_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 horas
}));

// SEÇÃO 4: CONFIGURAÇÕES DA DROGARIA
const DROGARIA_CONFIG = {
  nome: "Drogaria Dona Farma",
  endereco: "Avenida de Santa Cruz, 4249, Bangu, Rio de Janeiro, RJ - CEP: 21810-025",
  coordenadas: { lat: -22.87531, lng: -43.46488 },
  raioEntrega: 4, // km
  taxaEntrega: "R$ 2,00",
  horarioFuncionamento: {
    segunda_sexta: { inicio: 7, fim: 21, texto: "Segunda a Sexta: 7h às 21h" },
    sabado: { inicio: 7, fim: 20, texto: "Sábado: 7h às 20h" },
    domingo: { texto: "Domingo: Fechado" }
  },
  balconistas: [
    { 
      id: 'andrea', 
      nome: 'Andrea', 
      status: 'offline', 
      atendimentos: 0, 
      clientesAtivos: [],
      socketId: null,
      maxClientesSimultaneos: 3
    },
    { 
      id: 'cassiano', 
      nome: 'Cassiano', 
      status: 'offline', 
      atendimentos: 0, 
      clientesAtivos: [],
      socketId: null,
      maxClientesSimultaneos: 3
    }
  ],
  login: {
    usuario: 'admin',
    senha: '123456'
  }
};

// SEÇÃO 5: ESTADO GLOBAL DO SISTEMA
let clientes = {};
let sessoes = {};
let conversas = {};
let atendimentos = {};
let clienteNotas = {};
let timeoutsOciosidade = {};
let filaRoundRobin = 0;
let balconistasConectados = new Map();
let filaPendentes = []; // NOVO: Fila de clientes aguardando

// SEÇÃO 6: CLIENTE WHATSAPP
const client = new Client({
  authStrategy: new LocalAuth({ name: 'drogaria-session' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});

// SEÇÃO 7: FUNÇÕES DE PERSISTÊNCIA DE DADOS
function carregarDados() {
  try {
    if (fs.existsSync('clientes.json')) {
      clientes = JSON.parse(fs.readFileSync('clientes.json', 'utf8'));
      console.log(`Dados carregados: ${Object.keys(clientes).length} clientes`);
    }
    if (fs.existsSync('conversas.json')) {
      conversas = JSON.parse(fs.readFileSync('conversas.json', 'utf8'));
      console.log(`Dados carregados: ${Object.keys(conversas).length} conversas`);
    }
    if (fs.existsSync('atendimentos.json')) {
      atendimentos = JSON.parse(fs.readFileSync('atendimentos.json', 'utf8'));
    }
    if (fs.existsSync('sessoes.json')) {
      sessoes = JSON.parse(fs.readFileSync('sessoes.json', 'utf8'));
    }
    if (fs.existsSync('cliente_notas.json')) {
      clienteNotas = JSON.parse(fs.readFileSync('cliente_notas.json', 'utf8'));
    }
    if (fs.existsSync('fila_pendentes.json')) {
      filaPendentes = JSON.parse(fs.readFileSync('fila_pendentes.json', 'utf8'));
    }
  } catch (error) {
    console.log('Erro ao carregar dados:', error.message);
    clientes = {}; conversas = {}; atendimentos = {}; sessoes = {}; clienteNotas = {}; filaPendentes = [];
  }
}

function salvarDados() {
  try {
    fs.writeFileSync('clientes.json', JSON.stringify(clientes, null, 2));
    fs.writeFileSync('conversas.json', JSON.stringify(conversas, null, 2));
    fs.writeFileSync('atendimentos.json', JSON.stringify(atendimentos, null, 2));
    fs.writeFileSync('sessoes.json', JSON.stringify(sessoes, null, 2));
    fs.writeFileSync('cliente_notas.json', JSON.stringify(clienteNotas, null, 2));
    fs.writeFileSync('fila_pendentes.json', JSON.stringify(filaPendentes, null, 2));
  } catch (error) {
    console.log('Erro ao salvar dados:', error.message);
  }
}

// SEÇÃO 8: FUNÇÕES DE CÁLCULO DE DISTÂNCIA MELHORADA
async function calcularDistanciaPorRota(cepOrigem, cepDestino) {
  try {
    // Buscar coordenadas dos CEPs
    const [coordOrigem, coordDestino] = await Promise.all([
      buscarCoordenadasPorCEP(cepOrigem),
      buscarCoordenadasPorCEP(cepDestino)
    ]);

    console.log('Coordenadas origem:', coordOrigem);
    console.log('Coordenadas destino:', coordDestino);

    // Usar fórmula de Haversine para cálculo mais preciso
    const distancia = calcularDistanciaHaversine(
      coordOrigem.lat, 
      coordOrigem.lng, 
      coordDestino.lat, 
      coordDestino.lng
    );

    return parseFloat(distancia).toFixed(1);

  } catch (error) {
    console.log('Erro no cálculo de distância:', error.message);
    return '0.0';
  }
}

// Fórmula de Haversine para calcular distância entre duas coordenadas
function calcularDistanciaHaversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // Raio da Terra em km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  
  return distance.toFixed(1);
}

// SEÇÃO 9: FUNÇÕES DE GEOCODIFICAÇÃO
async function buscarCoordenadasPorCEP(cep) {
  try {
    const cepLimpo = cep.replace(/\D/g, '');
    
    // Buscar endereço via ViaCEP
    const viaCepResponse = await axios.get(`https://viacep.com.br/ws/${cepLimpo}/json/`, {
      timeout: 10000
    });
    
    if (viaCepResponse.data.erro) {
      throw new Error('CEP não encontrado');
    }
    
    const endereco = viaCepResponse.data;
    
    // Buscar coordenadas usando Nominatim
    const enderecoCompleto = `${endereco.logradouro}, ${endereco.bairro}, ${endereco.localidade}, ${endereco.uf}, Brasil`;
    
    const geocodeResponse = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        q: enderecoCompleto,
        format: 'json',
        limit: 1,
        countrycodes: 'br'
      },
      headers: {
        'User-Agent': 'Drogaria-Dona-Farma/2.1 (contato@donafarma.com.br)'
      },
      timeout: 10000
    });
    
    if (geocodeResponse.data.length > 0) {
      return {
        endereco,
        lat: parseFloat(geocodeResponse.data[0].lat),
        lng: parseFloat(geocodeResponse.data[0].lon)
      };
    }
    
    throw new Error('Coordenadas não encontradas');
    
  } catch (error) {
    console.log('Erro na geocodificação:', error.message);
    throw error;
  }
}

// SEÇÃO 10: FUNÇÕES DE VALIDAÇÃO
function validarCEP(cep) {
  const cepLimpo = cep.replace(/\D/g, '');
  return cepLimpo.length === 8 ? cepLimpo : null;
}

function validarNome(nome) {
  return nome && nome.trim().length >= 2 && nome.trim().length <= 50;
}

// CORREÇÃO: Função para formatar telefone corretamente
function formatarTelefone(numero) {
  const limpo = numero.replace(/\D/g, '');
  
  // Se já está no formato internacional completo
  if (limpo.length === 13 && limpo.startsWith('5521')) {
    return limpo;
  }
  
  // Se tem 11 dígitos e começa com 21 (DDD Rio)
  if (limpo.length === 11 && limpo.startsWith('21')) {
    return `55${limpo}`;
  }
  
  // Se tem 10 dígitos e começa com 21
  if (limpo.length === 10 && limpo.startsWith('21')) {
    return `5521${limpo.substring(2)}`;
  }
  
  return limpo;
}

// NOVO: Função para extrair número limpo brasileiro
function extrairNumeroBrasileiro(numeroCompleto) {
  // Remove @c.us e outros sufixos
  let numero = numeroCompleto.replace('@c.us', '').replace('@lid', '');
  
  // Se começa com 55 (código do Brasil), remove
  if (numero.startsWith('55') && numero.length === 13) {
    numero = numero.substring(2);
  }
  
  return numero;
}

// SEÇÃO 11: FUNÇÕES DE HORÁRIO
function estaNoHorarioFuncionamento() {
  const agora = new Date();
  const diaSemana = agora.getDay();
  const hora = agora.getHours();
  
  if (diaSemana >= 1 && diaSemana <= 5) { // Segunda a Sexta
    return hora >= 7 && hora < 21;
  } else if (diaSemana === 6) { // Sábado
    return hora >= 7 && hora < 20;
  } else { // Domingo
    return false;
  }
}

function obterProximoHorario() {
  const agora = new Date();
  const diaSemana = agora.getDay();
  const hora = agora.getHours();
  
  if (diaSemana >= 1 && diaSemana <= 5) { // Segunda a Sexta
    if (hora < 7) return "Abrimos às 7h";
    if (hora >= 21) return "Abrimos amanhã às 7h";
  } else if (diaSemana === 6) { // Sábado
    if (hora < 7) return "Abrimos às 7h";
    if (hora >= 20) return "Fechado domingo. Abrimos segunda às 7h";
  } else { // Domingo
    return "Fechado domingo. Abrimos segunda às 7h";
  }
  
  return "Estamos abertos agora";
}

// SEÇÃO 12: FUNÇÕES DE TIMEOUT DE OCIOSIDADE
function iniciarTimeoutOciosidade(numero) {
  // Limpar timeout anterior se existir
  if (timeoutsOciosidade[numero]) {
    clearTimeout(timeoutsOciosidade[numero]);
  }
  
  // Criar novo timeout de 5 minutos
  timeoutsOciosidade[numero] = setTimeout(async () => {
    const atendimento = atendimentos[numero];
    if (atendimento && atendimento.status === 'ativo') {
      // Avisar cliente antes de encerrar
      await enviarMensagem(numero, 
        `⚠️ *Atenção!* Seu atendimento será encerrado em 1 minuto devido à inatividade.\n\n` +
        `Se ainda precisar de ajuda, digite qualquer mensagem para continuar.`
      );
      
      // Aguardar 1 minuto e encerrar se ainda inativo
      setTimeout(async () => {
        const atendimentoAtual = atendimentos[numero];
        if (atendimentoAtual && atendimentoAtual.status === 'ativo') {
          await finalizarAtendimento(numero, atendimentoAtual.balconistaId, 'ociosidade');
        }
      }, 60000); // 1 minuto
    }
    delete timeoutsOciosidade[numero];
  }, 300000); // 5 minutos
}

function limparTimeoutOciosidade(numero) {
  if (timeoutsOciosidade[numero]) {
    clearTimeout(timeoutsOciosidade[numero]);
    delete timeoutsOciosidade[numero];
  }
}

// SEÇÃO 13: FUNÇÕES DE MENSAGEM
function adicionarMensagem(numero, tipo, conteudo, remetente, balconistaId = null) {
  if (!conversas[numero]) conversas[numero] = [];
  
  const mensagem = {
    id: Date.now() + Math.random(),
    tipo,
    conteudo,
    remetente,
    timestamp: new Date().toISOString(),
    lida: false,
    balconistaId
  };
  
  conversas[numero].push(mensagem);
  
  // Manter apenas últimas 100 mensagens
  if (conversas[numero].length > 100) {
    conversas[numero] = conversas[numero].slice(-100);
  }
  
  salvarDados();
  
  // Emitir para interface web
  io.emit('nova_mensagem', { numero, mensagem });
  
  return mensagem;
}

async function enviarMensagem(numero, texto, balconistaId = null) {
  try {
    const numeroCompleto = numero.includes('@') ? numero : `${numero}@c.us`;
    await client.sendMessage(numeroCompleto, texto);
    
    // CORREÇÃO: Usar número limpo para armazenamento
    const numeroLimpo = extrairNumeroBrasileiro(numero);
    adicionarMensagem(numeroLimpo, 'texto', texto, balconistaId ? 'balconista' : 'bot', balconistaId);
    
    console.log(`Mensagem enviada para ${numero}: ${texto.substring(0, 50)}...`);
    return true;
  } catch (error) {
    console.log('Erro ao enviar mensagem:', error.message);
    return false;
  }
}

// SEÇÃO 14: FUNÇÕES DE BALCONISTA MELHORADAS
function obterBalconistaDisponivel() {
  // Primeiro, verificar se há balconistas online
  const balconistasOnline = DROGARIA_CONFIG.balconistas.filter(b => b.status === 'online');
  
  if (balconistasOnline.length === 0) return null;
  
  // Encontrar o balconista com menor número de atendimentos ativos e que não atingiu o limite
  let melhorBalconista = null;
  let menorAtendimentos = Infinity;
  
  for (const balconista of balconistasOnline) {
    const atendimentosAtivos = balconista.clientesAtivos.length;
    
    // Se não atingiu o limite e tem menos atendimentos
    if (atendimentosAtivos < balconista.maxClientesSimultaneos && atendimentosAtivos < menorAtendimentos) {
      melhorBalconista = balconista;
      menorAtendimentos = atendimentosAtivos;
    }
  }
  
  // Se nenhum balconista disponível, usar round robin entre os que têm espaço
  if (!melhorBalconista) {
    const balconistasComEspaco = balconistasOnline.filter(b => 
      b.clientesAtivos.length < b.maxClientesSimultaneos
    );
    
    if (balconistasComEspaco.length > 0) {
      melhorBalconista = balconistasComEspaco[filaRoundRobin % balconistasComEspaco.length];
      filaRoundRobin++;
    }
  }
  
  return melhorBalconista;
}

function getStatusEmoji(balconistaId) {
  const balconista = DROGARIA_CONFIG.balconistas.find(b => b.id === balconistaId);
  if (!balconista) return '❓';
  
  switch (balconista.status) {
    case 'online': 
      return balconista.clientesAtivos.length >= balconista.maxClientesSimultaneos ? '🟡' : '🟢';
    case 'ocupado': return '🟡';
    case 'ausente': return '🔴';
    default: return '⚫';
  }
}

// NOVO: Função para processar fila de pendentes quando balconista fica online
async function processarFilaPendentes() {
  if (filaPendentes.length === 0) return;
  
  const balconista = obterBalconistaDisponivel();
  if (!balconista) return;
  
  // Pegar o primeiro da fila
  const clientePendente = filaPendentes.shift();
  salvarDados();
  
  console.log(`Processando cliente pendente: ${clientePendente.numero} -> ${balconista.nome}`);
  
  await iniciarAtendimento(clientePendente.numero, balconista);
  
  // Recursivamente processar próximo se ainda há balconistas disponíveis
  setTimeout(() => processarFilaPendentes(), 1000);
}

// SEÇÃO 15: FUNÇÃO PRINCIPAL DE PROCESSAMENTO - PRIMEIRO CONTATO
async function processarPrimeiroContato(numero, mensagem) {
  const texto = mensagem.body ? mensagem.body.trim() : '';
  const numeroLimpo = extrairNumeroBrasileiro(numero); // CORREÇÃO: Usar número limpo
  
  console.log(`Nova mensagem de ${numeroLimpo}: ${texto}`);
  
  // Adicionar mensagem do cliente
  adicionarMensagem(numeroLimpo, 'texto', texto, 'cliente');
  
  // Verificar horário de funcionamento
  if (!estaNoHorarioFuncionamento()) {
    await enviarMensagem(numero, 
      `🕐 *${DROGARIA_CONFIG.nome}*\n\n` +
      `Recebemos sua mensagem, mas estamos fora do horário de atendimento.\n\n` +
      `📅 *Nossos horários:*\n` +
      `${DROGARIA_CONFIG.horarioFuncionamento.segunda_sexta.texto}\n` +
      `${DROGARIA_CONFIG.horarioFuncionamento.sabado.texto}\n` +
      `${DROGARIA_CONFIG.horarioFuncionamento.domingo.texto}\n\n` +
      `⏰ ${obterProximoHorario()}\n\n` +
      `📝 Sua mensagem foi registrada e entraremos em contato assim que abrirmos!\n\n` +
      `🏪 *Endereço:* ${DROGARIA_CONFIG.endereco}`
    );
    
    // NOVO: Adicionar à fila de mensagens fora de horário
    filaPendentes.push({
      numero: numeroLimpo,
      mensagem: texto,
      timestamp: new Date().toISOString(),
      tipo: 'fora_horario'
    });
    salvarDados();
    return;
  }
  
  // Verificar se já existe cliente cadastrado
  if (clientes[numeroLimpo]) {
    await processarClienteExistente(numeroLimpo, texto);
    return;
  }
  
  // Primeiro contato - solicitar nome
  await enviarMensagem(numero, 
    `🏥 *Olá! Seja bem-vindo(a) à ${DROGARIA_CONFIG.nome}!*\n\n` +
    `Para oferecer o melhor atendimento, vou precisar de algumas informações.\n\n` +
    `😊 *Qual é o seu nome?*`
  );
  
  // Criar sessão para aguardar nome
  sessoes[numeroLimpo] = {
    etapa: 'aguardando_nome',
    iniciado: new Date().toISOString(),
    tentativas: 0
  };
  
  salvarDados();
}

// SEÇÃO 16: PROCESSAMENTO DE NOME
async function processarNome(numero, texto) {
  const sessao = sessoes[numero];
  
  if (!validarNome(texto)) {
    sessao.tentativas++;
    
    if (sessao.tentativas >= 3) {
      // Após 3 tentativas, encaminhar para balconista
      await encaminharParaBalconista(numero, 'Dificuldade no cadastro');
      return;
    }
    
    await enviarMensagem(numero, 
      `❌ *Nome inválido*\n\n` +
      `Por favor, digite seu nome completo (mínimo 2 caracteres):\n\n` +
      `📝 *Exemplo:* João Silva\n` +
      `🔄 *Tentativa ${sessao.tentativas}/3*`
    );
    return;
  }
  
  // Nome válido, salvar temporariamente e solicitar CEP
  sessao.nomeTemp = texto.trim();
  sessao.etapa = 'aguardando_cep';
  sessao.tentativas = 0;
  
  await enviarMensagem(numero, 
    `👋 *Prazer em conhecê-lo(a), ${sessao.nomeTemp}!*\n\n` +
    `📍 *Agora preciso do seu CEP para calcular a entrega:*\n\n` +
    `📮 *Digite apenas os 8 números do CEP:*\n` +
    `*Exemplo:* 21810025\n\n` +
    `💡 *Por que precisamos?* Para calcular distância e taxa de entrega.`
  );
  
  salvarDados();
}

// SEÇÃO 17: PROCESSAMENTO DE CEP
async function processarCEP(numero, texto) {
  const sessao = sessoes[numero];
  const cep = validarCEP(texto);
  
  if (!cep) {
    sessao.tentativas++;
    
    if (sessao.tentativas >= 3) {
      await encaminharParaBalconista(numero, 'Dificuldade com CEP');
      return;
    }
    
    await enviarMensagem(numero, 
      `❌ *CEP inválido*\n\n` +
      `Por favor, digite os 8 números do CEP:\n` +
      `📮 *Exemplo:* 21810025\n\n` +
      `🔄 *Tentativa ${sessao.tentativas}/3*`
    );
    return;
  }
  
  await enviarMensagem(numero, "🔍 *Consultando seu CEP...*\n⏳ Aguarde um momento...");
  
  try {
    // Buscar coordenadas e calcular distância
    const dadosEndereco = await buscarCoordenadasPorCEP(cep);
    const distancia = await calcularDistanciaPorRota('21810025', cep);
    
    const dentroAreaEntrega = parseFloat(distancia) <= DROGARIA_CONFIG.raioEntrega;
    
    // Salvar cliente
    clientes[numero] = {
      nome: sessao.nomeTemp,
      telefone: numero, // CORREÇÃO: Manter número limpo brasileiro
      cep: cep,
      endereco: `${dadosEndereco.endereco.logradouro}, ${dadosEndereco.endereco.bairro}, ${dadosEndereco.endereco.localidade} - ${dadosEndereco.endereco.uf}`,
      coordenadas: { lat: dadosEndereco.lat, lng: dadosEndereco.lng },
      distancia: distancia,
      dentroAreaEntrega: dentroAreaEntrega,
      cadastrado: new Date().toISOString(),
      primeiroContato: true
    };
    
    salvarDados();
    
    if (dentroAreaEntrega) {
      await enviarMensagem(numero, 
        `✅ *Perfeito! Fazemos entrega na sua região!*\n\n` +
        `📊 *Informações da entrega:*\n` +
        `📍 ${dadosEndereco.endereco.bairro}, ${dadosEndereco.endereco.localidade}\n` +
        `📏 Distância: ${distancia}km\n` +
        `💰 Taxa de entrega: ${DROGARIA_CONFIG.taxaEntrega}\n\n` +
        `👥 *Escolha seu atendente preferido:*\n` +
        `1️⃣ Andrea ${getStatusEmoji('andrea')}\n` +
        `2️⃣ Cassiano ${getStatusEmoji('cassiano')}\n\n` +
        `_Digite o número da sua escolha ou qualquer outra coisa para atendimento automático_`
      );
    } else {
      await enviarMensagem(numero, 
        `😔 *Sua região está fora da nossa área de entrega (${DROGARIA_CONFIG.raioEntrega}km)*\n\n` +
        `📊 *Informações:*\n` +
        `📍 ${dadosEndereco.endereco.bairro}, ${dadosEndereco.endereco.localidade}\n` +
        `📏 Distância: ${distancia}km\n\n` +
        `🏪 *MAS você pode retirar na loja!*\n\n` +
        `👥 *Escolha seu atendente:*\n` +
        `1️⃣ Andrea ${getStatusEmoji('andrea')}\n` +
        `2️⃣ Cassiano ${getStatusEmoji('cassiano')}\n\n` +
        `_Nossos atendentes podem ajudar com reservas para retirada_`
      );
    }
    
    sessao.etapa = 'escolhendo_balconista';
    salvarDados();
    
  } catch (error) {
    console.log('Erro ao processar CEP:', error.message);
    
    sessao.tentativas++;
    
    if (sessao.tentativas >= 2) {
      await encaminharParaBalconista(numero, 'Erro na consulta de CEP');
    } else {
      await enviarMensagem(numero, 
        `❌ *Erro ao consultar CEP*\n\n` +
        `Não consegui encontrar informações sobre esse CEP.\n\n` +
        `🔄 *Tente novamente ou será conectado com um atendente*`
      );
    }
  }
}

// SEÇÃO 18: PROCESSAMENTO CLIENTE EXISTENTE
async function processarClienteExistente(numero, texto) {
  const cliente = clientes[numero];
  const textoLower = texto.toLowerCase();
  
  // Verificar se está em atendimento ativo
  if (atendimentos[numero] && atendimentos[numero].status === 'ativo') {
    // Reiniciar timeout de ociosidade
    iniciarTimeoutOciosidade(numero);
    await repassarMensagemParaBalconista(numero, texto);
    return;
  }
  
  // Verificar horário de funcionamento
  if (!estaNoHorarioFuncionamento()) {
    await enviarMensagem(numero, 
      `🕐 *Olá ${cliente.nome}!*\n\n` +
      `Recebemos sua mensagem, mas estamos fora do horário de atendimento.\n\n` +
      `📅 *Nossos horários:*\n` +
      `${DROGARIA_CONFIG.horarioFuncionamento.segunda_sexta.texto}\n` +
      `${DROGARIA_CONFIG.horarioFuncionamento.sabado.texto}\n` +
      `${DROGARIA_CONFIG.horarioFuncionamento.domingo.texto}\n\n` +
      `⏰ ${obterProximoHorario()}\n\n` +
      `📝 Entraremos em contato assim que abrirmos!`
    );
    
    // NOVO: Adicionar à fila de mensagens fora de horário
    filaPendentes.push({
      numero: numero,
      mensagem: texto,
      timestamp: new Date().toISOString(),
      tipo: 'fora_horario',
      cliente: cliente
    });
    salvarDados();
    return;
  }
  
  // Mensagem de boas-vindas para cliente existente - MENU ATUALIZADO
  const statusEntrega = cliente.dentroAreaEntrega 
    ? `✅ Entrega: Sim (${cliente.distancia}km - ${DROGARIA_CONFIG.taxaEntrega})`
    : `🏪 Retirada na loja (fora da área de entrega - ${cliente.distancia}km)`;
  
  await enviarMensagem(numero, 
    `👋 *Olá ${cliente.nome}! Bem-vindo(a) de volta!*\n\n` +
    `📊 *Suas informações:*\n` +
    `📍 ${cliente.endereco}\n` +
    `${statusEntrega}\n\n` +
    `🛎️ *O que deseja hoje?*\n` +
    `1️⃣ Falar com Andrea ${getStatusEmoji('andrea')}\n` +
    `2️⃣ Falar com Cassiano ${getStatusEmoji('cassiano')}\n` +
    `3️⃣ Horário de funcionamento\n\n` +
    `💬 *Ou digite sua mensagem que conectaremos com um atendente disponível!*`
  );
  
  // Aguardar resposta do menu
  sessoes[numero] = {
    etapa: 'menu_cliente_existente',
    ultimaInteracao: new Date().toISOString()
  };
  
  // Aguardar 30 segundos, se não responder, encaminhar para balconista disponível
  setTimeout(async () => {
    if (sessoes[numero] && sessoes[numero].etapa === 'menu_cliente_existente') {
      await encaminharParaBalconista(numero, 'Sem resposta no menu');
    }
  }, 30000);
  
  salvarDados();
}

// SEÇÃO 19: PROCESSAMENTO DO MENU CLIENTE EXISTENTE
async function processarMenuClienteExistente(numero, opcao) {
  const cliente = clientes[numero];
  
  switch (opcao) {
    case '1':
      await escolherBalconista(numero, 'andrea');
      break;
    case '2':
      await escolherBalconista(numero, 'cassiano');
      break;
    case '3':
      await mostrarHorarioFuncionamento(numero);
      break;
    default:
      // Qualquer outra resposta encaminha para balconista disponível
      await encaminharParaBalconista(numero, opcao);
      break;
  }
}

// SEÇÃO 20: FUNÇÃO DE HORÁRIO DE FUNCIONAMENTO
async function mostrarHorarioFuncionamento(numero) {
  const agora = new Date();
  const diaSemana = agora.getDay();
  const hora = agora.getHours();
  
  let statusLoja = "";
  let proximoHorario = "";
  
  if (diaSemana >= 1 && diaSemana <= 5) { // Segunda a Sexta
    if (hora >= 7 && hora < 21) {
      statusLoja = "🟢 *ABERTA AGORA*";
      proximoHorario = "Fecha às 21h";
    } else {
      statusLoja = "🔴 *FECHADA*";
      proximoHorario = hora < 7 ? "Abre às 7h" : "Abre amanhã às 7h";
    }
  } else if (diaSemana === 6) { // Sábado
    if (hora >= 7 && hora < 20) {
      statusLoja = "🟢 *ABERTA AGORA*";
      proximoHorario = "Fecha às 20h";
    } else {
      statusLoja = "🔴 *FECHADA*";
      proximoHorario = hora < 7 ? "Abre às 7h" : "Fechada domingo";
    }
  } else { // Domingo
    statusLoja = "🔴 *FECHADA*";
    proximoHorario = "Abre segunda às 7h";
  }
  
  await enviarMensagem(numero,
    `⏰ *HORÁRIO DE FUNCIONAMENTO*\n\n` +
    `${statusLoja}\n` +
    `📅 ${proximoHorario}\n\n` +
    `🗓️ *Horários regulares:*\n` +
    `${DROGARIA_CONFIG.horarioFuncionamento.segunda_sexta.texto}\n` +
    `${DROGARIA_CONFIG.horarioFuncionamento.sabado.texto}\n` +
    `${DROGARIA_CONFIG.horarioFuncionamento.domingo.texto}\n\n` +
    `💬 *Atendimento WhatsApp:* Durante horário comercial\n\n` +
    `Digite qualquer coisa para falar com um atendente!`
  );
  
  delete sessoes[numero];
}

// SEÇÃO 21: ESCOLHA DE BALCONISTA - CORRIGIDA
async function escolherBalconista(numero, balconistaId) {
  const balconista = DROGARIA_CONFIG.balconistas.find(b => b.id === balconistaId);
  
  if (!balconista) {
    await encaminharParaBalconista(numero, 'Balconista não encontrado');
    return;
  }
  
  // CORREÇÃO: Verificar status corretamente
  if (balconista.status === 'online' && balconista.clientesAtivos.length < balconista.maxClientesSimultaneos) {
    await iniciarAtendimento(numero, balconista);
  } else if (balconista.status === 'offline') {
    // CORREÇÃO: Mensagem específica para balconista offline
    await enviarMensagem(numero,
      `🔴 *${balconista.nome} não está disponível no momento*\n\n` +
      `Vou conectar você com outro atendente disponível...\n\n` +
      `⏳ *Aguarde um instante...*`
    );
    
    setTimeout(async () => {
      await encaminharParaBalconista(numero, `Tentativa ${balconista.nome} indisponível`);
    }, 2000);
  } else {
    // Balconista ocupado mas online
    await enviarMensagem(numero,
      `🟡 *${balconista.nome} está ocupado no momento*\n\n` +
      `Vou conectar você com outro atendente disponível...\n\n` +
      `⏳ *Aguarde um instante...*`
    );
    
    setTimeout(async () => {
      await encaminharParaBalconista(numero, `Tentativa ${balconista.nome} ocupado`);
    }, 2000);
  }
}

// CORREÇÃO: Função de encaminhamento com mensagens corretas
async function encaminharParaBalconista(numero, motivo = 'Atendimento automático') {
  const balconista = obterBalconistaDisponivel();
  
  if (balconista) {
    await iniciarAtendimento(numero, balconista);
  } else {
    // CORREÇÃO: Verificar se há balconistas online
    const balconistasOnline = DROGARIA_CONFIG.balconistas.filter(b => b.status === 'online');
    
    let mensagem;
    if (balconistasOnline.length === 0) {
      // CORREÇÃO: Mensagem quando todos estão offline
      mensagem = `⏰ *No momento todos os atendentes estão ocupados*\n\n` +
                `Você será conectado assim que um atendente ficar disponível.\n\n` +
                `Obrigado pela paciência! 😊`;
    } else {
      // Todos online mas ocupados
      mensagem = `⏰ *No momento todos os atendentes estão ocupados*\n\n` +
                `Você será conectado assim que um atendente ficar disponível.\n\n` +
                `Obrigado pela paciência! 😊`;
    }
    
    await enviarMensagem(numero, mensagem);
    
    // Criar atendimento pendente
    atendimentos[numero] = {
      status: 'pendente',
      iniciado: new Date().toISOString(),
      motivo: motivo,
      cliente: clientes[numero] || { nome: 'Cliente', telefone: numero }
    };
    
    // NOVO: Adicionar à fila de pendentes
    filaPendentes.push({
      numero: numero,
      mensagem: motivo,
      timestamp: new Date().toISOString(),
      tipo: 'aguardando_balconista',
      cliente: clientes[numero] || { nome: 'Cliente', telefone: numero }
    });
    
    salvarDados();
  }
}

// SEÇÃO 22: SISTEMA DE ATENDIMENTO ATUALIZADO
async function iniciarAtendimento(numero, balconista) {
  const cliente = clientes[numero] || { nome: 'Cliente', telefone: numero };
  
  // Criar registro de atendimento
  atendimentos[numero] = {
    balconistaId: balconista.id,
    status: 'ativo',
    iniciado: new Date().toISOString(),
    cliente: cliente
  };
  
  // Adicionar cliente à lista ativa do balconista
  if (!balconista.clientesAtivos.includes(numero)) {
    balconista.clientesAtivos.push(numero);
  }
  
  balconista.atendimentos++;
  balconista.status = 'ocupado'; // Sempre ocupado quando tem clientes
  
  // NOVO: Remover da fila de pendentes se estiver lá
  filaPendentes = filaPendentes.filter(p => p.numero !== numero);
  
  salvarDados();
  
  const infoEntrega = cliente.dentroAreaEntrega 
    ? `🚚 Entrega: Sim (${cliente.distancia}km - ${DROGARIA_CONFIG.taxaEntrega})`
    : `🏪 Retirada na loja (${cliente.distancia}km da loja)`;
  
  // MENSAGEM ATUALIZADA - sem /sair
  await enviarMensagem(numero,
    `✅ *Conectado com ${balconista.nome}!*\n\n` +
    `👋 Olá ${cliente.nome}! Eu sou ${balconista.nome} e vou cuidar do seu atendimento.\n\n` +
    `📊 *Suas informações:*\n` +
    `${infoEntrega}\n\n` +
    `🎯 *Posso ajudar com:*\n` +
    `💊 Medicamentos e produtos\n` +
    `💰 Preços e promoções\n` +
    `📋 Receitas e orientações\n` +
    `🚚 Informações de entrega\n` +
    `🏪 Reservas para retirada\n\n` +
    `💬 *Como posso ajudá-lo hoje?*`
  );
  
  // Iniciar timeout de ociosidade
  iniciarTimeoutOciosidade(numero);
  
  // Notificar balconista via WebSocket
  if (balconista.socketId) {
    io.to(balconista.socketId).emit('novo_atendimento', {
      numero,
      cliente,
      conversa: conversas[numero] || [],
      atendimento: atendimentos[numero],
      timestamp: new Date().toISOString()
    });
  }
  
  delete sessoes[numero];
  console.log(`Atendimento iniciado: ${numero} -> ${balconista.nome}`);
  
  // Preparar dados para HubSpot (estrutura pronta)
  prepararDadosHubSpot(numero, 'atendimento_iniciado', { balconista: balconista.nome });
}

async function repassarMensagemParaBalconista(numero, mensagem) {
  const atendimento = atendimentos[numero];
  
  if (!atendimento || atendimento.status !== 'ativo') {
    await enviarMensagem(numero, "Erro: Atendimento não encontrado. Digite qualquer coisa para reiniciar.");
    delete atendimentos[numero];
    await processarPrimeiroContato(numero, { body: mensagem });
    return;
  }
  
  const balconista = DROGARIA_CONFIG.balconistas.find(b => b.id === atendimento.balconistaId);
  
  if (!balconista) {
    await enviarMensagem(numero, "Erro interno. Reiniciando atendimento...");
    delete atendimentos[numero];
    await processarPrimeiroContato(numero, { body: mensagem });
    return;
  }
  
  // Repassar mensagem para balconista
  if (balconista.socketId) {
    io.to(balconista.socketId).emit('mensagem_cliente', {
      numero,
      mensagem,
      cliente: clientes[numero] || { telefone: numero, nome: 'Cliente' },
      timestamp: new Date().toISOString()
    });
    
    console.log(`Mensagem repassada: ${numero} -> ${balconista.nome}`);
  } else {
    await enviarMensagem(numero,
      `😔 *${balconista.nome} ficou temporariamente indisponível.*\n\n` +
      `Redirecionando para outro atendente...\n\n` +
      `⏳ *Aguarde um momento...*`
    );
    
    balconista.status = 'offline';
    balconista.socketId = null;
    balconista.clientesAtivos = balconista.clientesAtivos.filter(n => n !== numero);
    
    // Tentar realocar para outro balconista
    setTimeout(async () => {
      await encaminharParaBalconista(numero, 'Realocação por desconexão');
    }, 2000);
  }
}

async function finalizarAtendimento(numero, balconistaId, iniciadoPor = 'sistema') {
  const atendimento = atendimentos[numero];
  const balconista = DROGARIA_CONFIG.balconistas.find(b => b.id === balconistaId);
  
  // Limpar timeout de ociosidade
  limparTimeoutOciosidade(numero);
  
  if (atendimento) {
    atendimento.status = 'finalizado';
    atendimento.finalizado = new Date().toISOString();
    atendimento.finalizadoPor = iniciadoPor;
    
    // Calcular duração
    const inicio = new Date(atendimento.iniciado);
    const fim = new Date();
    const duracao = Math.round((fim - inicio) / 1000 / 60);
    atendimento.duracao = duracao;
  }
  
  if (balconista) {
    balconista.clientesAtivos = balconista.clientesAtivos.filter(n => n !== numero);
    balconista.status = balconista.clientesAtivos.length === 0 ? 'online' : 'ocupado';
  }
  
  delete sessoes[numero];
  salvarDados();
  
  let mensagemFinal = '';
  
  if (iniciadoPor === 'balconista') {
    mensagemFinal = `✅ *Atendimento encerrado por ${balconista?.nome || 'atendente'}*\n\n`;
  } else if (iniciadoPor === 'ociosidade') {
    mensagemFinal = `⏰ *Atendimento encerrado por inatividade*\n\n`;
  } else {
    mensagemFinal = `✅ *Atendimento encerrado*\n\n`;
  }
  
  // MENSAGEM FINAL ATUALIZADA - sem avaliação
  await enviarMensagem(numero,
    mensagemFinal +
    `Obrigado por entrar em contato com a ${DROGARIA_CONFIG.nome}!\n\n` +
    `📞 *Para novo atendimento:*\n` +
    `Digite qualquer mensagem\n\n` +
    `🏪 *Visite nossa loja:*\n` +
    `${DROGARIA_CONFIG.endereco}\n\n` +
    `Tenha um ótimo dia!`
  );
  
  // Notificar balconista
  if (balconista && balconista.socketId) {
    io.to(balconista.socketId).emit('atendimento_finalizado', {
      numero,
      cliente: clientes[numero] || { telefone: numero },
      duracao: atendimento?.duracao || 0,
      iniciadoPor
    });
  }
  
  console.log(`Atendimento finalizado: ${numero} <- ${balconistaId} (${iniciadoPor})`);
  
  // NOVO: Processar fila de pendentes após finalizar atendimento
  setTimeout(() => processarFilaPendentes(), 1000);
  
  // Preparar dados para HubSpot
  prepararDadosHubSpot(numero, 'atendimento_finalizado', { 
    balconista: balconista?.nome,
    duracao: atendimento?.duracao,
    motivo: iniciadoPor
  });
}

// SEÇÃO 23: ROTEAMENTO PRINCIPAL DE MENSAGENS
async function processarMensagem(numero, mensagem) {
  const texto = mensagem.body ? mensagem.body.trim() : '';
  const numeroLimpo = extrairNumeroBrasileiro(numero); // CORREÇÃO: Usar número limpo
  
  // Verificar se está em atendimento ativo
  if (atendimentos[numeroLimpo] && atendimentos[numeroLimpo].status === 'ativo') {
    await repassarMensagemParaBalconista(numeroLimpo, texto);
    return;
  }
  
  // Verificar se tem sessão ativa
  if (sessoes[numeroLimpo]) {
    const sessao = sessoes[numeroLimpo];
    
    switch (sessao.etapa) {
      case 'aguardando_nome':
        await processarNome(numeroLimpo, texto);
        break;
      case 'aguardando_cep':
        await processarCEP(numeroLimpo, texto);
        break;
      case 'escolhendo_balconista':
        if (texto === '1') {
          await escolherBalconista(numeroLimpo, 'andrea');
        } else if (texto === '2') {
          await escolherBalconista(numeroLimpo, 'cassiano');
        } else {
          await encaminharParaBalconista(numeroLimpo, texto);
        }
        break;
      case 'menu_cliente_existente':
        await processarMenuClienteExistente(numeroLimpo, texto);
        break;
      default:
        await processarPrimeiroContato(numero, mensagem);
    }
  } else {
    // Não tem sessão, verificar se é cliente existente ou novo
    await processarPrimeiroContato(numero, mensagem);
  }
}

// SEÇÃO 24: PREPARAÇÃO PARA INTEGRAÇÃO HUBSPOT
function prepararDadosHubSpot(numero, evento, dadosAdicionais = {}) {
  const cliente = clientes[numero];
  
  if (!cliente) return;
  
  const dadosHubSpot = {
    telefone: numero,
    nome: cliente.nome,
    email: cliente.email || null,
    endereco: cliente.endereco,
    cep: cliente.cep,
    distancia_loja: cliente.distancia,
    dentro_area_entrega: cliente.dentroAreaEntrega,
    evento: evento,
    timestamp: new Date().toISOString(),
    ...dadosAdicionais
  };
  
  console.log(`HubSpot Data:`, JSON.stringify(dadosHubSpot, null, 2));
  
  // Salvar dados para posterior sincronização
  if (!fs.existsSync('hubspot_queue.json')) {
    fs.writeFileSync('hubspot_queue.json', JSON.stringify([], null, 2));
  }
  
  const queue = JSON.parse(fs.readFileSync('hubspot_queue.json', 'utf8'));
  queue.push(dadosHubSpot);
  fs.writeFileSync('hubspot_queue.json', JSON.stringify(queue, null, 2));
}

// SEÇÃO 25: WEBSOCKETS PARA PAINEL WEB - ATUALIZADO
io.on('connection', (socket) => {
  console.log(`Nova conexão web: ${socket.id}`);
  
  // Autenticação do balconista
  socket.on('balconista_login', (data) => {
    const { balconistaId } = data;
    
    const balconista = DROGARIA_CONFIG.balconistas.find(b => b.id === balconistaId);
    
    if (!balconista) {
      socket.emit('erro_login', { erro: 'Balconista não encontrado' });
      return;
    }
    
    balconista.status = 'online';
    balconista.socketId = socket.id;
    
    balconistasConectados.set(socket.id, {
      balconistaId,
      nome: balconista.nome,
      socket
    });
    
    const clientesAtivos = balconista.clientesAtivos.map(numero => ({
      numero,
      nome: clientes[numero]?.nome || 'Cliente',
      telefone: numero,
      endereco: clientes[numero]?.endereco || 'Não informado',
      conversa: conversas[numero] || []
    }));
    
    console.log(`${balconista.nome} logou via web com sucesso`);
    
    socket.emit('balconista_logado', {
      balconistaId,
      nome: balconista.nome,
      status: balconista.status,
      clientesAtivos,
      atendimentosHoje: balconista.atendimentos || 0
    });
    
    // NOVO: Processar fila de pendentes quando balconista fica online
    setTimeout(() => {
      processarFilaPendentes();
      
      // NOVO: Enviar mensagens fora de horário
      const mensagensForaHorario = filaPendentes.filter(p => p.tipo === 'fora_horario');
      if (mensagensForaHorario.length > 0) {
        socket.emit('mensagens_fora_horario', {
          mensagens: mensagensForaHorario,
          quantidade: mensagensForaHorario.length
        });
      }
    }, 1000);
  });
  
  // Logout do balconista
  socket.on('balconista_logout', (data) => {
    const { balconistaId } = data;
    const balconista = DROGARIA_CONFIG.balconistas.find(b => b.id === balconistaId);
    
    if (balconista) {
      balconista.status = 'offline';
      balconista.socketId = null;
      balconistasConectados.delete(socket.id);
      
      console.log(`${balconista.nome} deslogou via web`);
    }
  });
  
  // Alterar status
  socket.on('alterar_status', (data) => {
    const { balconistaId, status } = data;
    const balconista = DROGARIA_CONFIG.balconistas.find(b => b.id === balconistaId);
    
    if (balconista) {
      balconista.status = status;
      socket.emit('status_atualizado', { status });
      console.log(`Status de ${balconista.nome} alterado para: ${status}`);
      
      // Se ficou online, processar fila
      if (status === 'online') {
        setTimeout(() => processarFilaPendentes(), 500);
      }
    }
  });
  
  // Enviar mensagem via painel web
  socket.on('enviar_mensagem_balconista', async (data) => {
    const { numero, mensagem, balconistaId } = data;
    
    try {
      const balconista = DROGARIA_CONFIG.balconistas.find(b => b.id === balconistaId);
      if (!balconista) {
        socket.emit('erro', { mensagem: 'Balconista não encontrado' });
        return;
      }
      
      // Reiniciar timeout de ociosidade
      iniciarTimeoutOciosidade(numero);
      
      // CORREÇÃO: Usar número com formato WhatsApp para envio
      const numeroWhatsApp = numero.includes('@') ? numero : `${numero}@c.us`;
      const sucesso = await enviarMensagem(numeroWhatsApp, mensagem, balconistaId);
      
      if (sucesso) {
        console.log(`Mensagem enviada via web por ${balconista.nome} para ${numero}`);
        socket.emit('mensagem_enviada', {
          numero,
          mensagem,
          timestamp: new Date().toISOString(),
          remetente: 'balconista'
        });
      } else {
        socket.emit('erro', { mensagem: 'Falha ao enviar mensagem' });
      }
    } catch (error) {
      console.error('Erro ao enviar mensagem via web:', error);
      socket.emit('erro', { mensagem: 'Erro interno do servidor' });
    }
  });
  
  // Finalizar atendimento
  socket.on('finalizar_atendimento', async (data) => {
    const { numero, balconistaId } = data;
    await finalizarAtendimento(numero, balconistaId, 'balconista');
    socket.emit('atendimento_finalizado', { numero });
  });

  // TRANSFERIR ATENDIMENTO - FUNCIONALIDADE CORRIGIDA
  socket.on('transferir_atendimento', async (data) => {
    const { numero, deBalconista, paraBalconista, motivo } = data;
    
    try {
      const balconistaOrigem = DROGARIA_CONFIG.balconistas.find(b => b.id === deBalconista);
      const balconistaDestino = DROGARIA_CONFIG.balconistas.find(b => b.id === paraBalconista);
      
      if (!balconistaOrigem || !balconistaDestino) {
        socket.emit('erro', { mensagem: 'Balconista não encontrado' });
        return;
      }
      
      if (balconistaDestino.status !== 'online' || 
          balconistaDestino.clientesAtivos.length >= balconistaDestino.maxClientesSimultaneos) {
        socket.emit('erro', { mensagem: 'Balconista de destino não está disponível' });
        return;
      }
      
      const atendimento = atendimentos[numero];
      if (!atendimento || atendimento.status !== 'ativo') {
        socket.emit('erro', { mensagem: 'Atendimento não encontrado' });
        return;
      }
      
      // Limpar timeout de ociosidade
      limparTimeoutOciosidade(numero);
      
      // Remover cliente da lista do balconista origem
      balconistaOrigem.clientesAtivos = balconistaOrigem.clientesAtivos.filter(n => n !== numero);
      balconistaOrigem.status = balconistaOrigem.clientesAtivos.length === 0 ? 'online' : 'ocupado';
      
      // Adicionar cliente ao balconista destino
      if (!balconistaDestino.clientesAtivos.includes(numero)) {
        balconistaDestino.clientesAtivos.push(numero);
      }
      balconistaDestino.status = 'ocupado';
      
      // Atualizar atendimento
      atendimento.balconistaId = paraBalconista;
      atendimento.transferido = new Date().toISOString();
      atendimento.motivoTransferencia = motivo || 'Transferência manual';
      
      salvarDados();
      
      // Notificar cliente sobre transferência
      const cliente = clientes[numero] || { nome: 'Cliente' };
      const numeroWhatsApp = numero.includes('@') ? numero : `${numero}@c.us`;
      await enviarMensagem(numeroWhatsApp,
        `🔄 *Transferência de Atendimento*\n\n` +
        `Você foi transferido para ${balconistaDestino.nome}.\n\n` +
        `👋 Olá ${cliente.nome}! Sou ${balconistaDestino.nome} e darei continuidade ao seu atendimento.\n\n` +
        `💬 Como posso ajudá-lo?`
      );
      
      // Reiniciar timeout de ociosidade
      iniciarTimeoutOciosidade(numero);
      
      // Notificar balconista de destino - CORREÇÃO: Manter histórico
      if (balconistaDestino.socketId) {
        io.to(balconistaDestino.socketId).emit('novo_atendimento', {
          numero,
          cliente,
          conversa: conversas[numero] || [], // CORREÇÃO: Manter histórico completo
          atendimento: atendimentos[numero],
          transferido: true,
          deBalconista: balconistaOrigem.nome,
          timestamp: new Date().toISOString()
        });
      }
      
      // Notificar balconista de origem
      socket.emit('transferencia_realizada', {
        numero,
        paraBalconista: balconistaDestino.nome
      });
      
      console.log(`Atendimento transferido: ${numero} de ${balconistaOrigem.nome} para ${balconistaDestino.nome}`);
      
    } catch (error) {
      console.error('Erro ao transferir atendimento:', error);
      socket.emit('erro', { mensagem: 'Erro interno ao transferir' });
    }
  });

  // SALVAR NOTAS DO CLIENTE - FUNCIONALIDADE CORRIGIDA
  socket.on('salvar_nota_cliente', (data) => {
    const { numero, nota, balconistaId } = data;
    
    try {
      if (!clienteNotas[numero]) {
        clienteNotas[numero] = [];
      }
      
      const novaNota = {
        id: Date.now(),
        texto: nota,
        balconistaId,
        balconistaNome: DROGARIA_CONFIG.balconistas.find(b => b.id === balconistaId)?.nome || 'Desconhecido',
        timestamp: new Date().toISOString()
      };
      
      clienteNotas[numero].push(novaNota);
      salvarDados();
      
      socket.emit('nota_salva', {
        numero,
        nota: novaNota
      });
      
      console.log(`Nota salva para cliente ${numero} por ${novaNota.balconistaNome}`);
      
    } catch (error) {
      console.error('Erro ao salvar nota:', error);
      socket.emit('erro', { mensagem: 'Erro ao salvar nota' });
    }
  });

  // OBTER NOTAS DO CLIENTE
  socket.on('obter_notas_cliente', (data) => {
    const { numero } = data;
    
    const notas = clienteNotas[numero] || [];
    
    socket.emit('notas_cliente', {
      numero,
      notas
    });
  });
  
  // Desconexão
  socket.on('disconnect', (reason) => {
    console.log(`Desconexão web: ${socket.id} (${reason})`);
    
    const balconistaInfo = balconistasConectados.get(socket.id);
    if (balconistaInfo) {
      const balconista = DROGARIA_CONFIG.balconistas.find(b => b.id === balconistaInfo.balconistaId);
      if (balconista) {
        balconista.status = 'offline';
        balconista.socketId = null;
      }
      balconistasConectados.delete(socket.id);
      console.log(`${balconistaInfo.nome} desconectado do painel web`);
    }
  });
});

// SEÇÃO 26: ROTAS DO PAINEL WEB (mantidas iguais)
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  } else {
    return res.redirect('/login');
  }
}

app.get('/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Login - ${DROGARIA_CONFIG.nome}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
          height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .login-container {
          background: white;
          padding: 2rem;
          border-radius: 15px;
          box-shadow: 0 10px 25px rgba(0,0,0,0.1);
          width: 100%;
          max-width: 400px;
        }
        .logo {
          text-align: center;
          margin-bottom: 2rem;
        }
        .logo h1 {
          color: #128C7E;
          font-size: 1.5rem;
          margin-bottom: 0.5rem;
        }
        .form-group {
          margin-bottom: 1rem;
        }
        label {
          display: block;
          margin-bottom: 0.5rem;
          color: #333;
          font-weight: 500;
        }
        input {
          width: 100%;
          padding: 12px;
          border: 2px solid #ddd;
          border-radius: 8px;
          font-size: 16px;
          transition: border-color 0.3s;
        }
        input:focus {
          outline: none;
          border-color: #25D366;
        }
        .btn {
          width: 100%;
          padding: 12px;
          background: #25D366;
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 16px;
          cursor: pointer;
          transition: background 0.3s;
        }
        .btn:hover {
          background: #128C7E;
        }
        .error {
          color: #e74c3c;
          text-align: center;
          margin-top: 1rem;
        }
      </style>
    </head>
    <body>
      <div class="login-container">
        <div class="logo">
          <h1>🏥 ${DROGARIA_CONFIG.nome}</h1>
          <p>Painel de Atendimento</p>
        </div>
        <form method="POST" action="/login">
          <div class="form-group">
            <label for="usuario">Usuário:</label>
            <input type="text" id="usuario" name="usuario" required>
          </div>
          <div class="form-group">
            <label for="senha">Senha:</label>
            <input type="password" id="senha" name="senha" required>
          </div>
          <button type="submit" class="btn">Entrar</button>
          ${req.query.error ? '<div class="error">Usuário ou senha inválidos</div>' : ''}
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post('/login', (req, res) => {
  const { usuario, senha } = req.body;
  
  if (usuario === DROGARIA_CONFIG.login.usuario && senha === DROGARIA_CONFIG.login.senha) {
    req.session.authenticated = true;
    res.redirect('/painel');
  } else {
    res.redirect('/login?error=1');
  }
});

// Painel principal
app.get('/painel', requireAuth, (req, res) => {
  const balconistaId = req.query.balconista;
  
  if (!balconistaId) {
    // Mostrar página de seleção de balconista
    res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Selecionar Balconista - ${DROGARIA_CONFIG.nome}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #333;
          }
          .selection-container {
            background: white;
            padding: 2rem;
            border-radius: 15px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.1);
            width: 100%;
            max-width: 500px;
            text-align: center;
          }
          .logo {
            margin-bottom: 2rem;
          }
          .logo h1 {
            color: #128C7E;
            font-size: 1.8rem;
            margin-bottom: 0.5rem;
          }
          .balconista-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1rem;
            margin: 2rem 0;
          }
          .balconista-card {
            background: #f8f9fa;
            border: 2px solid #e9ecef;
            border-radius: 12px;
            padding: 1.5rem;
            cursor: pointer;
            transition: all 0.3s;
            text-decoration: none;
            color: inherit;
          }
          .balconista-card:hover {
            background: #e7f3ff;
            border-color: #25D366;
            transform: translateY(-2px);
          }
          .balconista-avatar {
            width: 60px;
            height: 60px;
            border-radius: 50%;
            background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 24px;
            font-weight: bold;
            margin: 0 auto 1rem;
          }
          .balconista-name {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 0.5rem;
          }
          .balconista-status {
            font-size: 14px;
            opacity: 0.7;
          }
          .logout-btn {
            position: absolute;
            top: 20px;
            right: 20px;
            background: #dc3545;
            color: white;
            padding: 10px 20px;
            border-radius: 8px;
            text-decoration: none;
            font-size: 14px;
            transition: background 0.3s;
          }
          .logout-btn:hover {
            background: #c82333;
          }
        </style>
      </head>
      <body>
        <a href="/logout" class="logout-btn">
          <i class="fas fa-sign-out-alt"></i> Sair
        </a>
        
        <div class="selection-container">
          <div class="logo">
            <h1>🏥 ${DROGARIA_CONFIG.nome}</h1>
            <p>Selecione seu perfil de atendimento</p>
          </div>
          
          <div class="balconista-grid">
            ${DROGARIA_CONFIG.balconistas.map(balconista => `
              <a href="/painel?balconista=${balconista.id}" class="balconista-card">
                <div class="balconista-avatar">
                  ${balconista.nome.charAt(0).toUpperCase()}
                </div>
                <div class="balconista-name">${balconista.nome}</div>
                <div class="balconista-status">
                  ${balconista.status === 'online' ? '🟢 Disponível' : '🔴 Offline'}
                </div>
              </a>
            `).join('')}
          </div>
          
          <p style="color: #666; font-size: 14px; margin-top: 1rem;">
            Escolha seu perfil para acessar o painel de atendimento WhatsApp
          </p>
        </div>
        
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
      </body>
      </html>
    `);
  } else {
    // Verificar se o balconista existe
    const balconista = DROGARIA_CONFIG.balconistas.find(b => b.id === balconistaId);
    
    if (!balconista) {
      res.redirect('/painel');
      return;
    }
    
    // Salvar balconista na sessão
    req.session.balconistaId = balconistaId;
    req.session.balconistaNome = balconista.nome;
    
    // Servir o painel principal
    res.sendFile(path.join(__dirname, 'public', 'painel.html'));
  }
});

// Informações do balconista logado
app.get('/api/balconista-atual', requireAuth, (req, res) => {
  const balconistaId = req.session.balconistaId;
  
  if (!balconistaId) {
    return res.status(401).json({ erro: 'Balconista não identificado' });
  }
  
  const balconista = DROGARIA_CONFIG.balconistas.find(b => b.id === balconistaId);
  
  if (!balconista) {
    return res.status(404).json({ erro: 'Balconista não encontrado' });
  }
  
  res.json({
    id: balconista.id,
    nome: balconista.nome,
    status: balconista.status,
    atendimentos: balconista.atendimentos,
    clientesAtivos: balconista.clientesAtivos.length
  });
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Rota principal redireciona para painel
app.get('/', (req, res) => {
  res.redirect('/painel');
});

// SEÇÃO 27: APIs REST
app.get('/api/estatisticas', (req, res) => {
  const hoje = new Date().toISOString().split('T')[0];
  
  const atendimentosHoje = Object.values(atendimentos).filter(a => 
    a.iniciado && a.iniciado.startsWith(hoje)
  );
  
  const stats = {
    clientesTotal: Object.keys(clientes).length,
    atendimentosHoje: atendimentosHoje.length,
    atendimentosAtivos: Object.values(atendimentos).filter(a => a.status === 'ativo').length,
    filaPendentes: filaPendentes.length, // NOVO
    balconistas: DROGARIA_CONFIG.balconistas.map(b => ({
      id: b.id,
      nome: b.nome,
      status: b.status,
      clientesAtivos: b.clientesAtivos.length,
      atendimentosHoje: b.atendimentos
    }))
  };
  
  res.json(stats);
});

// CORREÇÃO: API para obter conversas com número limpo
app.get('/api/conversas/:numero', (req, res) => {
  const numero = req.params.numero;
  const numeroLimpo = extrairNumeroBrasileiro(numero); // CORREÇÃO
  const conversa = conversas[numeroLimpo] || [];
  const cliente = clientes[numeroLimpo] || null;
  
  res.json({
    numero: numeroLimpo, // CORREÇÃO: Retornar número limpo
    cliente,
    mensagens: conversa.slice(-50), // CORREÇÃO: Manter histórico
    notas: clienteNotas[numeroLimpo] || []
  });
});

// SEÇÃO 28: EVENTOS DO WHATSAPP
client.on('qr', (qr) => {
  console.log('QR Code gerado. Escaneie com o WhatsApp:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('WhatsApp conectado e pronto!');
  console.log(`${DROGARIA_CONFIG.nome} - Sistema iniciado`);
});

client.on('authenticated', () => {
  console.log('WhatsApp autenticado com sucesso');
});

client.on('auth_failure', (msg) => {
  console.error('Falha na autenticação WhatsApp:', msg);
});

client.on('disconnected', (reason) => {
  console.log('WhatsApp desconectado:', reason);
});

client.on('message_create', async (message) => {
  if (message.fromMe) return;
  if (message.from.includes('@g.us')) return;
  
  const numero = message.from.replace('@c.us', '');
  
  try {
    await processarMensagem(numero, message);
  } catch (error) {
    console.error('Erro ao processar mensagem:', error);
    try {
      await enviarMensagem(numero, "Ocorreu um erro interno. Tente novamente em alguns instantes.");
    } catch (sendError) {
      console.error('Erro ao enviar mensagem de erro:', sendError);
    }
  }
});

// SEÇÃO 29: LIMPEZA E MANUTENÇÃO
setInterval(() => {
  const agora = new Date();
  
  // Limpar sessões antigas (mais de 2 horas sem atividade)
  Object.keys(sessoes).forEach(numero => {
    const sessao = sessoes[numero];
    if (sessao.ultimaInteracao) {
      const ultimaInteracao = new Date(sessao.ultimaInteracao);
      if (ultimaInteracao < new Date(agora.getTime() - 2 * 60 * 60 * 1000)) {
        delete sessoes[numero];
        console.log(`Sessão limpa: ${numero} (inativa há mais de 2h)`);
      }
    }
  });
  
  // Limpar fila de pendentes antiga (mais de 24h)
  filaPendentes = filaPendentes.filter(p => {
    const timestampPendente = new Date(p.timestamp);
    return timestampPendente > new Date(agora.getTime() - 24 * 60 * 60 * 1000);
  });
  
  // Reset contadores diários
  if (agora.getHours() === 0 && agora.getMinutes() === 0) {
    DROGARIA_CONFIG.balconistas.forEach(b => {
      b.atendimentos = 0;
    });
    console.log('Contadores resetados (novo dia)');
  }
  
  salvarDados();
}, 10 * 60 * 1000); // A cada 10 minutos

// SEÇÃO 30: TRATAMENTO DE ERROS
process.on('uncaughtException', (error) => {
  console.error('Erro não capturado:', error);
  salvarDados();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promise rejeitada não tratada:', reason);
});

// SEÇÃO 31: INICIALIZAÇÃO DO SISTEMA
async function iniciarSistema() {
  try {
    console.log('🚀 Iniciando sistema da Drogaria Dona Farma...');
    
    carregarDados();
    await client.initialize();
    
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`🌐 Servidor rodando na porta ${PORT}`);
      console.log(`📊 Painel: http://localhost:${PORT}/painel`);
      console.log(`🏥 ${DROGARIA_CONFIG.nome} - Sistema pronto!`);
      console.log(`📍 ${DROGARIA_CONFIG.endereco}`);
      console.log(`🚚 Área de entrega: ${DROGARIA_CONFIG.raioEntrega}km`);
      console.log(`💰 Taxa de entrega: ${DROGARIA_CONFIG.taxaEntrega}`);
      console.log('\n=== CORREÇÕES IMPLEMENTADAS ===');
      console.log('✅ 1. Mensagens corretas para balconistas offline/ocupados');
      console.log('✅ 2. Sistema de fila de pendentes funcionando');
      console.log('✅ 3. Conexão automática quando balconistas ficam online');
      console.log('✅ 4. Campo telefone mostra apenas número brasileiro');
      console.log('✅ 5. Histórico de mensagens mantido na transferência');
      console.log('✅ 6. Mensagens fora de horário enviadas ao balconista');
      console.log('✅ 7. Sistema de processamento de fila otimizado');
      console.log('✅ 8. Correção no formato de números WhatsApp');
      console.log('✅ 9. Persistência de dados da fila de pendentes');
      console.log('✅ 10. Limpeza automática de dados antigos');
      console.log('=====================================\n');
    });
    
  } catch (error) {
    console.error('❌ Erro ao iniciar sistema:', error);
    process.exit(1);
  }
}

// Tratamento de sinais do sistema
process.on('SIGINT', () => {
  console.log('\n🛑 Salvando dados e encerrando...');
  salvarDados();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Salvando dados e encerrando...');
  salvarDados();
  process.exit(0);
});

// SEÇÃO 32: INICIAR O SISTEMA
iniciarSistema();

module.exports = { app, client, DROGARIA_CONFIG };