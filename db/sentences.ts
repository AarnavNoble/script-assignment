// Read-aloud script sentences, one list per language. Everyday topics (weather, cooking, travel, work,
// numbers and dates, questions, short dialogue) so the recordings cover varied sounds.
// Written for this project; not taken from any corpus. One sentence per line below.

const RAW: Record<string, string> = {
  en: `
The weather forecast says it will rain this afternoon, so bring an umbrella.
Could you tell me how to get to the nearest train station?
I usually make a cup of tea before I start working in the morning.
Our meeting has been moved from Tuesday to Thursday at half past two.
Add a pinch of salt to the water before you put the pasta in.
The bus was twenty minutes late because of heavy traffic downtown.
Do you know if the library is open on Sunday afternoons?
My grandmother grows tomatoes, beans and peppers in her small garden.
Please remember to turn off the lights when you leave the room.
We are planning a trip to the mountains at the end of next month.
The total comes to forty-seven dollars and fifty cents, including tax.
"Are you coming to dinner tonight?" "Yes, but I might be a little late."
It gets dark much earlier now that winter is almost here.
I left my keys on the kitchen table next to the fruit bowl.
The children played outside until their parents called them in for lunch.
Can you send me the report before the end of the day?
There is a small bakery on the corner that sells fresh bread every morning.
My flight leaves at six fifteen, so I need to be at the airport by four.
She learned to play the piano when she was only seven years old.
Stir the soup slowly and let it simmer for another ten minutes.
The museum is closed for repairs until the third of March.
How long does it usually take you to walk to work?
A strong wind blew most of the leaves off the trees last night.
I would like a table for four near the window, please.
We counted more than one hundred birds on the lake this morning.
The new printer on the second floor still isn't working properly.
"Excuse me, is this seat taken?" "No, please go ahead and sit down."
If you finish your homework early, we can go to the park together.
My brother called to say that his train arrived safely in the city.
The price of apples has gone up again since the beginning of the year.
Turn left at the second traffic light and the hotel will be on your right.
I forgot to buy milk, so we will have to drink our coffee black.
The temperature dropped below freezing for the first time this season.
Could you speak a little more slowly? I didn't catch the last part.
Every Saturday morning we clean the house and then go to the market.
The doctor told him to drink more water and get plenty of rest.
Our team finished the whole project two days ahead of schedule.
The cat sleeps on the warm windowsill whenever the sun comes out.
Please write your phone number and today's date at the top of the form.
"What time does the movie start?" "I think it begins at a quarter to eight."
We took the ferry across the bay and watched the sunset from the deck.
Chop the onions finely and fry them in a little oil until golden.
I have lived in this neighborhood for almost twelve years now.
The road along the coast is beautiful, but it can be very narrow.
Would you mind closing the window? It's getting a bit cold in here.
My phone battery is almost empty, so I may not be able to call you later.
The farmers hope for a good harvest after such a warm and sunny summer.
Let's meet in front of the old clock tower at noon tomorrow.
He spent the whole weekend painting the fence behind the house.
The class starts at nine, but the teacher usually arrives a little early.
Is there a pharmacy around here that stays open late at night?
A light snow began to fall just as we reached the top of the hill.
I need to return these books to the library by Friday afternoon.
Our neighbors invited us over for a barbecue on Saturday evening.
The office will be closed on Monday because of the public holiday.
"Did you sleep well?" "Not really, the thunder kept me awake for hours."
Mix the flour, sugar and eggs in a large bowl until the batter is smooth.
The train to the airport runs every fifteen minutes during the day.
She always keeps a notebook in her bag to write down new ideas.
We should leave now if we want to get there before it starts raining.
My sister is twenty-three, and she just started her first job as a nurse.
The river was so calm that we could see the clouds reflected in it.
Please wait here for a moment while I check if the manager is available.
The shop on the main street sells shoes, bags and warm winter coats.
I usually go jogging in the park before breakfast on weekdays.
`,

  es: `
El pronóstico dice que esta tarde va a llover, así que lleva paraguas.
¿Podrías decirme dónde está la parada de autobús más cercana?
Siempre preparo un café con leche antes de empezar a trabajar.
La reunión se ha cambiado del martes al jueves a las tres.
Echa una pizca de sal al agua antes de poner la pasta.
El tren llegó con veinte minutos de retraso por culpa de la lluvia.
Mi abuela cultiva tomates, pimientos y lechugas en su pequeño huerto.
Por favor, apaga las luces cuando salgas de la habitación.
Estamos planeando un viaje a la montaña para finales del mes que viene.
En total son cuarenta y siete euros con cincuenta céntimos.
—¿Vienes a cenar esta noche? —Sí, pero llegaré un poco tarde.
Ahora anochece mucho antes porque ya casi es invierno.
Dejé las llaves en la mesa de la cocina, al lado de la fruta.
Los niños jugaron en el parque hasta que sus padres los llamaron.
¿Me puedes enviar el informe antes de que termine el día?
Hay una panadería en la esquina que vende pan recién hecho cada mañana.
Mi vuelo sale a las seis y cuarto, así que debo estar en el aeropuerto a las cuatro.
Aprendió a tocar el piano cuando tenía solo siete años.
Remueve la sopa despacio y déjala a fuego lento diez minutos más.
El museo estará cerrado por obras hasta el tres de marzo.
¿Cuánto tiempo tardas normalmente en llegar a tu trabajo?
Anoche el viento fuerte arrancó casi todas las hojas de los árboles.
Quisiera una mesa para cuatro personas cerca de la ventana, por favor.
Esta mañana contamos más de cien pájaros en el lago.
La impresora nueva del segundo piso todavía no funciona bien.
—Perdone, ¿está libre este asiento? —Sí, siéntese, por favor.
Si terminas los deberes pronto, podemos ir juntos al parque.
El precio de las manzanas ha vuelto a subir desde principios de año.
Gira a la izquierda en el segundo semáforo y verás el hotel a la derecha.
Se me olvidó comprar leche, así que tomaremos el café solo.
¿Podrías hablar un poco más despacio? No entendí la última parte.
Todos los sábados limpiamos la casa y después vamos al mercado.
El médico le dijo que bebiera más agua y que descansara mucho.
El gato duerme junto a la ventana cada vez que sale el sol.
Escribe tu número de teléfono y la fecha de hoy en la parte de arriba.
—¿A qué hora empieza la película? —Creo que a las ocho menos cuarto.
Pica la cebolla muy fina y fríela en un poco de aceite.
Vivo en este barrio desde hace casi doce años.
¿Te importaría cerrar la ventana? Empieza a hacer frío aquí dentro.
Mi móvil casi no tiene batería, así que quizás no pueda llamarte luego.
Quedamos mañana a mediodía delante de la torre del reloj.
Pasó todo el fin de semana pintando la valla detrás de la casa.
¿Hay alguna farmacia por aquí que abra hasta tarde?
Empezó a nevar justo cuando llegamos a lo alto de la colina.
Tengo que devolver estos libros a la biblioteca antes del viernes.
`,

  hi: `
आज शाम को बारिश होने की संभावना है, इसलिए छाता साथ ले जाना।
क्या आप मुझे बता सकते हैं कि सबसे पास वाला बस स्टॉप कहाँ है?
मैं रोज़ सुबह काम शुरू करने से पहले एक कप चाय पीता हूँ।
हमारी बैठक मंगलवार की जगह अब गुरुवार को तीन बजे होगी।
दाल में थोड़ा नमक और हल्दी डालकर उसे धीमी आँच पर पकाइए।
भारी ट्रैफ़िक की वजह से बस आज बीस मिनट देर से आई।
मेरी दादी अपने छोटे से बगीचे में टमाटर और मिर्च उगाती हैं।
कृपया कमरे से बाहर जाते समय बत्ती बंद करना न भूलें।
हम अगले महीने के आख़िर में पहाड़ों पर घूमने जाने की सोच रहे हैं।
कुल मिलाकर आपका बिल चार सौ पचास रुपये का हुआ है।
"क्या तुम आज रात खाने पर आ रहे हो?" "हाँ, पर थोड़ी देर हो सकती है।"
सर्दियाँ आने वाली हैं, इसलिए अब शाम जल्दी हो जाती है।
मैंने अपनी चाबियाँ रसोई की मेज़ पर फलों की टोकरी के पास छोड़ दी थीं।
बच्चे दोपहर तक बाहर खेलते रहे, फिर माँ ने उन्हें खाने के लिए बुलाया।
क्या आप आज शाम तक मुझे वह रिपोर्ट भेज सकते हैं?
नुक्कड़ पर एक छोटी सी दुकान है जहाँ हर सुबह ताज़ी ब्रेड मिलती है।
मेरी उड़ान सुबह छह बजे की है, इसलिए मुझे चार बजे तक हवाई अड्डे पहुँचना होगा।
उसने सिर्फ़ सात साल की उम्र में हारमोनियम बजाना सीख लिया था।
संग्रहालय मरम्मत के कारण तीन मार्च तक बंद रहेगा।
आपको पैदल दफ़्तर पहुँचने में आम तौर पर कितना समय लगता है?
कल रात तेज़ हवा चली और पेड़ों के ज़्यादातर पत्ते गिर गए।
कृपया हमें खिड़की के पास चार लोगों के लिए एक मेज़ दीजिए।
आज सुबह हमने झील पर सौ से ज़्यादा पक्षी गिने।
दूसरी मंज़िल वाला नया प्रिंटर अब भी ठीक से काम नहीं कर रहा है।
"माफ़ कीजिए, क्या यह सीट खाली है?" "जी हाँ, आराम से बैठिए।"
अगर तुम अपना गृहकार्य जल्दी ख़त्म कर लो, तो हम साथ में पार्क चलेंगे।
इस साल की शुरुआत से सेब के दाम फिर से बढ़ गए हैं।
दूसरे चौराहे से बाएँ मुड़िए, होटल आपके दाहिनी ओर होगा।
मैं दूध लाना भूल गया, इसलिए आज बिना दूध की चाय पीनी पड़ेगी।
क्या आप थोड़ा धीरे बोल सकते हैं? मैं आख़िरी बात समझ नहीं पाया।
हर शनिवार सुबह हम घर की सफ़ाई करते हैं और फिर बाज़ार जाते हैं।
डॉक्टर ने उसे ज़्यादा पानी पीने और अच्छी तरह आराम करने की सलाह दी।
हमारी टीम ने यह काम तय समय से दो दिन पहले पूरा कर लिया।
धूप निकलते ही बिल्ली गर्म खिड़की के पास जाकर सो जाती है।
कृपया फ़ॉर्म के ऊपर अपना फ़ोन नंबर और आज की तारीख़ लिखिए।
"फ़िल्म कितने बजे शुरू होगी?" "मुझे लगता है पौने आठ बजे।"
प्याज़ को बारीक काटिए और थोड़े तेल में सुनहरा होने तक भूनिए।
मैं पिछले लगभग बारह सालों से इसी मोहल्ले में रह रहा हूँ।
क्या आप खिड़की बंद कर देंगे? यहाँ थोड़ी ठंड लग रही है।
मेरे फ़ोन की बैटरी लगभग ख़त्म है, शायद मैं बाद में फ़ोन न कर पाऊँ।
चलो कल दोपहर बारह बजे पुराने घंटाघर के सामने मिलते हैं।
उसने पूरा सप्ताहांत घर के पीछे की दीवार रंगने में बिता दिया।
क्या यहाँ आसपास कोई दवा की दुकान है जो देर रात तक खुली रहती है?
मुझे शुक्रवार तक ये किताबें पुस्तकालय में लौटानी हैं।
`,

  pt: `
A previsão do tempo diz que vai chover hoje à tarde.
Você pode me dizer onde fica o ponto de ônibus mais próximo?
Eu sempre tomo um café antes de começar a trabalhar de manhã.
A reunião foi transferida de terça para quinta, às três horas.
Coloque uma pitada de sal na água antes de acrescentar o macarrão.
O ônibus atrasou vinte minutos por causa do trânsito no centro.
Minha avó planta tomates, feijão e pimentões no seu pequeno quintal.
Por favor, apague as luzes quando sair da sala.
Estamos planejando uma viagem para a serra no fim do mês que vem.
O total ficou em quarenta e sete reais e cinquenta centavos.
"Você vem jantar hoje à noite?" "Venho, mas talvez eu chegue um pouco atrasado."
Agora escurece bem mais cedo porque o inverno está chegando.
Deixei as chaves na mesa da cozinha, ao lado da fruteira.
As crianças brincaram lá fora até os pais chamarem para o almoço.
Você pode me mandar o relatório até o fim do dia?
Tem uma padaria na esquina que vende pão fresquinho toda manhã.
Meu voo sai às seis e quinze, então preciso estar no aeroporto às quatro.
Ela aprendeu a tocar piano quando tinha só sete anos.
Mexa a sopa devagar e deixe cozinhar em fogo baixo por mais dez minutos.
O museu vai ficar fechado para reforma até o dia três de março.
Quanto tempo você costuma levar para chegar ao trabalho a pé?
O vento forte de ontem à noite derrubou quase todas as folhas das árvores.
Eu queria uma mesa para quatro pessoas perto da janela, por favor.
Hoje de manhã contamos mais de cem pássaros na lagoa.
A impressora nova do segundo andar ainda não está funcionando direito.
"Com licença, este lugar está ocupado?" "Não, pode sentar à vontade."
Se você terminar a lição de casa cedo, a gente vai junto ao parque.
O preço da maçã subiu de novo desde o começo do ano.
Vire à esquerda no segundo semáforo e o hotel vai estar à sua direita.
Esqueci de comprar leite, então vamos tomar o café puro.
Você pode falar um pouco mais devagar? Não entendi a última parte.
Todo sábado de manhã a gente limpa a casa e depois vai à feira.
O médico disse para ele beber mais água e descansar bastante.
O gato dorme perto da janela sempre que o sol aparece.
Escreva seu telefone e a data de hoje no alto do formulário.
"Que horas começa o filme?" "Acho que às quinze para as oito."
Pique a cebola bem fininha e refogue em um pouco de azeite.
Eu moro neste bairro há quase doze anos e gosto muito daqui.
Você se importa de fechar a janela? Está ficando frio aqui dentro.
A bateria do meu celular está quase acabando, talvez eu não consiga te ligar depois.
Vamos nos encontrar amanhã ao meio-dia na frente da torre do relógio.
Ele passou o fim de semana inteiro pintando o muro atrás de casa.
Tem alguma farmácia aqui perto que fica aberta até tarde?
Começou a garoar bem na hora em que chegamos ao alto do morro.
Preciso devolver estes livros na biblioteca até sexta-feira.
`,

  fr: `
La météo annonce de la pluie pour cet après-midi, prends un parapluie.
Pourriez-vous me dire où se trouve l'arrêt de bus le plus proche ?
Je bois toujours un café avant de commencer à travailler le matin.
La réunion a été déplacée de mardi à jeudi, à quinze heures.
Ajoute une pincée de sel dans l'eau avant de mettre les pâtes.
Le train avait vingt minutes de retard à cause de la neige.
Ma grand-mère cultive des tomates, des haricots et des poivrons dans son petit jardin.
N'oublie pas d'éteindre la lumière quand tu quittes la pièce.
Nous prévoyons un voyage à la montagne à la fin du mois prochain.
Cela fait quarante-sept euros et cinquante centimes au total, s'il vous plaît.
« Tu viens dîner ce soir ? » « Oui, mais j'arriverai peut-être un peu en retard. »
Il fait nuit beaucoup plus tôt maintenant que l'hiver approche.
J'ai laissé mes clés sur la table de la cuisine, à côté de la corbeille de fruits.
Les enfants ont joué dehors jusqu'à ce que leurs parents les appellent pour déjeuner.
Peux-tu m'envoyer le rapport avant la fin de la journée ?
Il y a une petite boulangerie au coin de la rue qui vend du pain frais chaque matin.
Mon vol part à six heures et quart, je dois donc être à l'aéroport à quatre heures.
Elle a appris à jouer du piano quand elle n'avait que sept ans.
Remue la soupe doucement et laisse-la mijoter encore dix minutes.
Le musée est fermé pour travaux jusqu'au trois mars inclus.
Combien de temps te faut-il d'habitude pour aller au travail à pied ?
Le vent a soufflé si fort cette nuit que presque toutes les feuilles sont tombées.
Je voudrais une table pour quatre personnes près de la fenêtre, s'il vous plaît.
Ce matin, nous avons compté plus de cent oiseaux sur le lac.
La nouvelle imprimante du deuxième étage ne marche toujours pas correctement.
« Pardon, cette place est libre ? » « Oui, je vous en prie, asseyez-vous. »
Si tu finis tes devoirs tôt, on pourra aller au parc ensemble.
Le prix des pommes a encore augmenté depuis le début de l'année.
Tournez à gauche au deuxième feu, et l'hôtel sera sur votre droite.
J'ai oublié d'acheter du lait, alors on boira le café noir.
Pourriez-vous parler un peu plus lentement ? Je n'ai pas compris la fin.
Tous les samedis matin, nous faisons le ménage puis nous allons au marché.
Le médecin lui a conseillé de boire plus d'eau et de bien se reposer.
Le chat dort sur le rebord de la fenêtre dès que le soleil apparaît.
Écrivez votre numéro de téléphone et la date du jour en haut du formulaire.
« À quelle heure commence le film ? » « Je crois qu'il commence à huit heures moins le quart. »
Émince finement les oignons et fais-les revenir dans un peu d'huile.
J'habite dans ce quartier depuis presque douze ans maintenant.
Ça te dérange de fermer la fenêtre ? Il commence à faire froid ici.
Mon téléphone n'a presque plus de batterie, je ne pourrai peut-être pas t'appeler plus tard.
Retrouvons-nous demain à midi devant la vieille tour de l'horloge.
Il a passé tout le week-end à repeindre la clôture derrière la maison.
Est-ce qu'il y a une pharmacie ouverte tard le soir dans le quartier ?
Il a commencé à neiger juste au moment où nous arrivions en haut de la colline.
Je dois rendre ces livres à la bibliothèque avant vendredi.
`,

  de: `
Laut Wetterbericht soll es heute Nachmittag regnen, also nimm einen Schirm mit.
Können Sie mir bitte sagen, wo die nächste Bushaltestelle ist?
Ich trinke immer eine Tasse Kaffee, bevor ich morgens mit der Arbeit anfange.
Die Besprechung wurde von Dienstag auf Donnerstag um drei Uhr verschoben.
Gib eine Prise Salz ins Wasser, bevor du die Nudeln hineingibst.
Der Zug hatte wegen des starken Schneefalls zwanzig Minuten Verspätung.
Meine Großmutter baut in ihrem kleinen Garten Tomaten, Bohnen und Paprika an.
Bitte denk daran, das Licht auszumachen, wenn du den Raum verlässt.
Wir planen Ende nächsten Monats eine Reise in die Berge.
Das macht insgesamt siebenundvierzig Euro und fünfzig Cent, bitte.
„Kommst du heute Abend zum Essen?“ „Ja, aber ich komme vielleicht etwas später.“
Jetzt, wo der Winter kommt, wird es abends viel früher dunkel.
Ich habe meine Schlüssel auf dem Küchentisch neben der Obstschale liegen lassen.
Die Kinder spielten draußen, bis ihre Eltern sie zum Mittagessen riefen.
Kannst du mir den Bericht bitte bis heute Abend schicken?
An der Ecke gibt es eine kleine Bäckerei, die jeden Morgen frisches Brot verkauft.
Mein Flug geht um Viertel nach sechs, deshalb muss ich um vier am Flughafen sein.
Sie hat schon mit sieben Jahren angefangen, Klavier zu spielen.
Rühr die Suppe langsam um und lass sie noch zehn Minuten köcheln.
Das Museum bleibt wegen Renovierungsarbeiten bis zum dritten März geschlossen.
Wie lange brauchst du normalerweise zu Fuß zur Arbeit?
Der starke Wind hat letzte Nacht fast alle Blätter von den Bäumen geweht.
Ich hätte gern einen Tisch für vier Personen am Fenster, bitte.
Heute Morgen haben wir mehr als hundert Vögel auf dem See gezählt.
Der neue Drucker im zweiten Stock funktioniert immer noch nicht richtig.
„Entschuldigung, ist dieser Platz noch frei?“ „Ja, setzen Sie sich ruhig.“
Wenn du deine Hausaufgaben früh fertig hast, gehen wir zusammen in den Park.
Die Äpfel sind seit Anfang des Jahres schon wieder teurer geworden.
Biegen Sie an der zweiten Ampel links ab, dann ist das Hotel auf der rechten Seite.
Ich habe vergessen, Milch zu kaufen, also trinken wir den Kaffee schwarz.
Könnten Sie bitte etwas langsamer sprechen? Ich habe den letzten Teil nicht verstanden.
Jeden Samstagmorgen putzen wir die Wohnung und gehen danach auf den Markt.
Der Arzt hat ihm geraten, mehr Wasser zu trinken und sich gut auszuruhen.
Die Katze schläft auf der warmen Fensterbank, sobald die Sonne herauskommt.
Schreiben Sie bitte Ihre Telefonnummer und das heutige Datum oben auf das Formular.
„Wann fängt der Film an?“ „Ich glaube, um Viertel vor acht.“
Schneide die Zwiebeln fein und brate sie in etwas Öl goldbraun an.
Ich wohne jetzt schon seit fast zwölf Jahren in diesem Viertel.
Würdest du bitte das Fenster schließen? Es wird langsam kalt hier drin.
Mein Handy hat fast keinen Akku mehr, vielleicht kann ich dich später nicht anrufen.
Lass uns morgen um zwölf Uhr vor dem alten Uhrturm treffen.
Er hat das ganze Wochenende damit verbracht, den Zaun hinter dem Haus zu streichen.
Gibt es hier in der Nähe eine Apotheke, die abends lange geöffnet hat?
Es fing genau dann an zu schneien, als wir oben auf dem Hügel ankamen.
Ich muss diese Bücher bis Freitag in die Bibliothek zurückbringen.
`,

  ar: `
تقول نشرة الطقس إن المطر سيهطل بعد ظهر اليوم، فلا تنسَ المظلة.
هل يمكنك أن تخبرني أين أقرب محطة للحافلات من هنا؟
أشرب دائمًا فنجانًا من القهوة قبل أن أبدأ العمل في الصباح.
تم تأجيل الاجتماع من يوم الثلاثاء إلى يوم الخميس في الساعة الثالثة.
أضف قليلًا من الملح إلى الماء قبل أن تضع المعكرونة.
تأخرت الحافلة عشرين دقيقة بسبب الازدحام الشديد في وسط المدينة.
تزرع جدتي الطماطم والفلفل والنعناع في حديقتها الصغيرة خلف البيت.
من فضلك، أطفئ الأنوار عندما تخرج من الغرفة.
نخطط للقيام برحلة إلى الجبال في نهاية الشهر القادم.
المبلغ الإجمالي هو سبعة وأربعون دينارًا وخمسون قرشًا مع الضريبة.
«هل ستأتي إلى العشاء الليلة؟» «نعم، لكنني قد أتأخر قليلًا.»
صار الظلام يحل مبكرًا الآن لأن الشتاء قد اقترب.
تركت مفاتيحي على طاولة المطبخ بجانب سلة الفواكه.
لعب الأطفال في الخارج حتى ناداهم أهلهم لتناول الغداء.
هل يمكنك أن ترسل لي التقرير قبل نهاية اليوم؟
يوجد مخبز صغير عند زاوية الشارع يبيع الخبز الطازج كل صباح.
تقلع طائرتي في السادسة والربع، لذلك يجب أن أكون في المطار عند الرابعة.
تعلمت العزف على البيانو عندما كانت في السابعة من عمرها فقط.
حرّك الحساء ببطء واتركه على نار هادئة عشر دقائق أخرى.
سيبقى المتحف مغلقًا للصيانة حتى الثالث من شهر مارس.
كم من الوقت تستغرق عادةً للوصول إلى عملك سيرًا على الأقدام؟
هبّت رياح قوية الليلة الماضية وأسقطت معظم أوراق الأشجار.
أريد طاولة لأربعة أشخاص بالقرب من النافذة، من فضلك.
أحصينا هذا الصباح أكثر من مئة طائر على البحيرة.
الطابعة الجديدة في الطابق الثاني لا تعمل بشكل صحيح حتى الآن.
«عفوًا، هل هذا المقعد محجوز؟» «لا، تفضل بالجلوس.»
إذا أنهيت واجباتك مبكرًا، يمكننا أن نذهب إلى الحديقة معًا.
ارتفع سعر التفاح مرة أخرى منذ بداية هذا العام.
انعطف يسارًا عند الإشارة الضوئية الثانية، وستجد الفندق على يمينك.
نسيت أن أشتري الحليب، لذلك سنشرب القهوة من دونه اليوم.
هل يمكنك أن تتكلم ببطء أكثر؟ لم أفهم الجزء الأخير.
في كل صباح سبت ننظف البيت ثم نذهب إلى السوق.
نصحه الطبيب بأن يشرب المزيد من الماء وأن يرتاح جيدًا.
تنام القطة قرب النافذة الدافئة كلما أشرقت الشمس.
اكتب رقم هاتفك وتاريخ اليوم في أعلى الاستمارة.
«متى يبدأ الفيلم؟» «أظن أنه يبدأ في الثامنة إلا ربعًا.»
قطّع البصل قطعًا صغيرة واقلِه في قليل من الزيت حتى يصبح ذهبيًا.
أسكن في هذا الحي منذ ما يقارب اثني عشر عامًا.
هل تمانع أن تغلق النافذة؟ بدأ الجو يبرد هنا.
بطارية هاتفي على وشك النفاد، فقد لا أتمكن من الاتصال بك لاحقًا.
لنلتقِ غدًا عند الظهر أمام برج الساعة القديم.
قضى عطلة نهاية الأسبوع كلها في طلاء السور خلف البيت.
هل توجد صيدلية قريبة من هنا تبقى مفتوحة حتى وقت متأخر؟
بدأ الثلج يتساقط في اللحظة التي وصلنا فيها إلى قمة التل.
يجب أن أعيد هذه الكتب إلى المكتبة قبل يوم الجمعة.
`,

  bn: `
আবহাওয়ার খবরে বলছে আজ বিকেলে বৃষ্টি হতে পারে, তাই ছাতা নিয়ে যেও।
আপনি কি বলতে পারবেন সবচেয়ে কাছের বাস স্ট্যান্ডটা কোথায়?
আমি প্রতিদিন সকালে কাজ শুরু করার আগে এক কাপ চা খাই।
আমাদের মিটিংটা মঙ্গলবার থেকে সরিয়ে বৃহস্পতিবার বিকেল তিনটায় নেওয়া হয়েছে।
ডাল রান্নার সময় একটু লবণ আর হলুদ দিয়ে কম আঁচে ফুটতে দিন।
রাস্তায় খুব জ্যাম থাকায় বাসটা আজ বিশ মিনিট দেরিতে এসেছে।
আমার দিদিমা তাঁর ছোট্ট বাগানে টমেটো, লঙ্কা আর বেগুন চাষ করেন।
ঘর থেকে বের হওয়ার সময় দয়া করে আলোটা নিভিয়ে দেবেন।
আমরা সামনের মাসের শেষে পাহাড়ে বেড়াতে যাওয়ার পরিকল্পনা করছি।
সব মিলিয়ে আপনার বিল হয়েছে চারশো পঞ্চাশ টাকা, ভ্যাট সহ।
"আজ রাতে খেতে আসছ তো?" "হ্যাঁ, তবে একটু দেরি হতে পারে।"
শীত এসে গেছে, তাই এখন সন্ধ্যা অনেক তাড়াতাড়ি নামে।
আমি চাবিগুলো রান্নাঘরের টেবিলে ফলের ঝুড়ির পাশে রেখে এসেছি।
বাচ্চারা দুপুর পর্যন্ত বাইরে খেলছিল, তারপর মা তাদের খেতে ডাকলেন।
আপনি কি আজ সন্ধ্যার মধ্যে রিপোর্টটা আমাকে পাঠাতে পারবেন?
মোড়ের মাথায় একটা ছোট দোকান আছে, যেখানে রোজ সকালে টাটকা পাউরুটি পাওয়া যায়।
আমার ফ্লাইট সকাল ছটায়, তাই চারটের মধ্যে বিমানবন্দরে পৌঁছাতে হবে।
মাত্র সাত বছর বয়সে সে হারমোনিয়াম বাজাতে শিখেছিল।
মেরামতের কাজের জন্য জাদুঘরটি তেসরা মার্চ পর্যন্ত বন্ধ থাকবে।
হেঁটে অফিসে যেতে আপনার সাধারণত কতক্ষণ সময় লাগে?
কাল রাতে জোরে হাওয়া দিয়েছিল, গাছের প্রায় সব পাতা ঝরে গেছে।
দয়া করে জানালার পাশে চারজনের জন্য একটা টেবিল দেবেন?
আজ সকালে আমরা দিঘির ধারে একশোরও বেশি পাখি গুনেছি।
দোতলার নতুন প্রিন্টারটা এখনও ঠিকমতো কাজ করছে না।
"মাফ করবেন, এই সিটটা কি খালি?" "হ্যাঁ, বসুন।"
তুমি যদি তাড়াতাড়ি পড়া শেষ করো, তাহলে আমরা একসঙ্গে পার্কে যাব।
বছরের শুরু থেকে আপেলের দাম আবার বেড়ে গেছে।
দ্বিতীয় মোড় থেকে বাঁদিকে ঘুরলেই হোটেলটা আপনার ডানদিকে পড়বে।
দুধ কিনতে ভুলে গেছি, তাই আজ লিকার চা খেতে হবে।
আপনি কি একটু আস্তে বলবেন? শেষের কথাটা ঠিক বুঝতে পারিনি।
প্রতি শনিবার সকালে আমরা ঘর পরিষ্কার করি, তারপর বাজারে যাই।
ডাক্তার তাকে বেশি করে জল খেতে আর ভালো করে বিশ্রাম নিতে বলেছেন।
আমাদের দল নির্ধারিত সময়ের দুদিন আগেই কাজটা শেষ করেছে।
রোদ উঠলেই বিড়ালটা জানালার ধারে গিয়ে ঘুমিয়ে পড়ে।
ফর্মের ওপরে আপনার ফোন নম্বর আর আজকের তারিখ লিখুন।
"সিনেমাটা কটায় শুরু হবে?" "আমার মনে হয় পৌনে আটটায় শুরু হবে।"
পেঁয়াজ মিহি করে কেটে অল্প তেলে বাদামি হওয়া পর্যন্ত ভাজুন।
আমি প্রায় বারো বছর ধরে এই পাড়াতেই থাকি।
জানালাটা একটু বন্ধ করে দেবে? এখানে বেশ ঠান্ডা লাগছে।
আমার ফোনের চার্জ প্রায় শেষ, তাই পরে হয়তো ফোন করতে পারব না।
চলো, কাল দুপুর বারোটায় পুরনো ঘড়িঘরের সামনে দেখা করি।
সে পুরো সপ্তাহান্ত বাড়ির পেছনের দেয়াল রং করে কাটিয়েছে।
কাছাকাছি কি এমন কোনো ওষুধের দোকান আছে যেটা অনেক রাত পর্যন্ত খোলা থাকে?
শুক্রবারের মধ্যে আমাকে বইগুলো লাইব্রেরিতে ফেরত দিতে হবে।
`,

  ja: `
天気予報によると、今日の午後は雨が降るそうなので、傘を持っていってください。
すみません、一番近い駅への行き方を教えていただけますか。
私は毎朝、仕事を始める前に温かいお茶を一杯飲みます。
会議は火曜日から木曜日の午後三時に変更になりました。
パスタを入れる前に、お湯に塩をひとつまみ入れてください。
道が混んでいたので、バスが二十分も遅れて到着しました。
祖母は小さな庭でトマトやナス、きゅうりを育てています。
部屋を出るときは、電気を消すのを忘れないでくださいね。
来月の終わりに、家族で山のほうへ旅行に行く予定です。
お会計は全部で三千四百五十円になりますが、カードでもお支払いいただけます。
「今晩、夕ご飯を食べに来る？」「うん、でも少し遅くなるかもしれない。」
冬が近づいてきて、最近は日が暮れるのがずいぶん早くなりました。
鍵は台所のテーブルの上、果物かごの隣に置いておきました。
子どもたちは、お昼ご飯に呼ばれるまで外で元気に遊んでいました。
今日中に、その報告書をメールで送っていただけますか。
角に小さなパン屋があって、毎朝焼きたてのパンを売っています。
飛行機は朝六時十五分発なので、四時までに空港に着かないといけません。
彼女はまだ七歳のときに、ピアノを習い始めました。
スープをゆっくり混ぜながら、弱火でもう十分ほど煮込んでください。
博物館は改装工事のため、三月三日まで休館しています。
歩いて会社まで行くのに、ふだんどのくらいかかりますか。
昨夜は風が強くて、木の葉がほとんど落ちてしまいました。
窓際の四人がけの席が空いていたら、そちらをお願いできますか。
今朝、湖のほとりで百羽以上の鳥を数えました。
二階の新しいプリンターが、まだうまく動きません。
「すみません、この席は空いていますか。」「はい、どうぞお座りください。」
宿題を早く終わらせたら、一緒に公園に行こうね。
年の初めから、りんごの値段がまた上がりました。
二つ目の信号を左に曲がると、右側にホテルが見えます。
牛乳を買い忘れたので、今日はコーヒーをブラックで飲みましょう。
もう少しゆっくり話していただけますか。最後のところが聞き取れませんでした。
毎週土曜日の朝は、家を掃除してから市場に買い物に行きます。
お医者さんに、水をたくさん飲んでゆっくり休むように言われました。
日が差してくると、猫はいつも暖かい窓辺で昼寝をします。
用紙の一番上に、電話番号と今日の日付を書いてください。
「映画は何時に始まるの？」「たしか七時四十五分だったと思う。」
玉ねぎを細かく刻んで、少しの油できつね色になるまで炒めます。
この町に住んで、もうすぐ十二年になります。
窓を閉めてもらってもいいですか。ちょっと寒くなってきました。
携帯の電池がもうすぐ切れそうなので、あとで電話できないかもしれません。
明日の正午に、古い時計台の前で待ち合わせしましょう。
彼は週末ずっと、家の裏の塀にペンキを塗っていました。
この近くに、夜遅くまで開いている薬局はありますか。
ちょうど丘の上に着いたとき、雪がちらちらと降り始めました。
金曜日までに、この本を図書館に返さなければなりません。
`,

  ko: `
일기예보에 따르면 오늘 오후에 비가 온다고 하니 우산을 챙기세요.
실례지만, 가장 가까운 지하철역에 어떻게 가는지 알려 주시겠어요?
저는 매일 아침 일을 시작하기 전에 따뜻한 차를 한 잔 마셔요.
다음 주 회의가 화요일에서 목요일 오후 세 시로 변경되었습니다.
파스타를 넣기 전에 끓는 물에 소금을 조금 넣어 주세요.
길이 많이 막혀서 버스가 이십 분이나 늦게 도착했어요.
할머니께서는 집 뒤의 작은 텃밭에서 고추와 상추, 토마토를 기르세요.
방에서 나갈 때 불 끄는 것을 잊지 마세요.
다음 달 말에 가족들과 함께 산으로 여행을 갈 계획이에요.
모두 합쳐서 삼만 사천오백 원입니다. 카드로 결제하시겠어요, 아니면 현금으로 하시겠어요?
"오늘 저녁 먹으러 올 거야?" "응, 그런데 조금 늦을 수도 있어."
겨울이 가까워지면서 요즘은 저녁에 해가 훨씬 일찍 지네요.
열쇠는 부엌 식탁 위 과일 바구니 옆에 두었어요.
아이들은 점심 먹으라고 부를 때까지 밖에서 신나게 놀았어요.
오늘 퇴근하기 전까지 그 보고서를 보내 주실 수 있나요?
길모퉁이에 작은 빵집이 있는데, 매일 아침 갓 구운 빵을 팔아요.
비행기가 아침 여섯 시 십오 분에 출발해서 네 시까지 공항에 가야 해요.
그녀는 겨우 일곱 살 때부터 피아노를 배우기 시작했다고 해요.
수프를 천천히 저으면서 약한 불에서 십 분 더 끓여 주세요.
박물관은 보수 공사 때문에 삼월 삼일까지 문을 닫습니다.
집에서 회사까지 걸어서 가면 보통 시간이 얼마나 걸리세요?
어젯밤에 바람이 세게 불어서 나뭇잎이 거의 다 떨어졌어요.
창가 쪽에 네 명이 앉을 수 있는 자리로 부탁드려요.
오늘 아침에 호수에서 새를 백 마리도 넘게 세었어요.
이층에 새로 들어온 프린터가 아직도 제대로 작동하지 않아요.
"실례지만 이 자리 비어 있나요?" "네, 편하게 앉으세요."
숙제를 일찍 끝내면 오후에 같이 공원에 놀러 가자.
올해 초부터 시장에서 파는 사과 값이 또 많이 올랐어요.
두 번째 신호등에서 왼쪽으로 돌면 오른쪽에 호텔이 보여요.
우유 사는 걸 깜빡해서 오늘은 커피를 블랙으로 마셔야겠어요.
조금만 천천히 말씀해 주시겠어요? 마지막 부분을 잘 못 들었어요.
매주 토요일 아침에는 집 청소를 하고 나서 시장에 가요.
의사 선생님이 물을 많이 마시고 푹 쉬라고 하셨어요.
해가 나면 고양이는 늘 따뜻한 창가에서 낮잠을 자요.
신청서 맨 위에 전화번호와 오늘 날짜를 적어 주세요.
"영화 몇 시에 시작해?" "아마 일곱 시 사십오 분일 거야."
양파를 잘게 썰어서 기름을 조금 두르고 노릇하게 볶아 주세요.
이 동네에 산 지 벌써 십이 년이 다 되어 가요.
창문 좀 닫아 줄 수 있어요? 여기 좀 추워졌어요.
휴대폰 배터리가 거의 다 돼서 이따가 전화를 못 할 수도 있어요.
내일 정오에 광장에 있는 오래된 시계탑 앞에서 만나기로 해요.
그는 주말 내내 집 뒤의 울타리에 페인트를 칠했어요.
혹시 이 근처에 밤늦게까지 문을 여는 약국이 있나요?
언덕 꼭대기에 막 도착했을 때 눈이 내리기 시작했어요.
이번 주 금요일까지 이 책들을 도서관에 꼭 반납해야 해요.
`,

  id: `
Menurut prakiraan cuaca, sore ini akan turun hujan, jadi bawalah payung.
Permisi, bisakah Anda memberi tahu saya di mana halte bus terdekat?
Saya selalu minum secangkir teh sebelum mulai bekerja di pagi hari.
Rapat kita dipindahkan dari hari Selasa ke hari Kamis pukul tiga sore.
Tambahkan sedikit garam ke dalam air sebelum memasukkan mi.
Busnya terlambat dua puluh menit karena jalanan di pusat kota sangat macet.
Nenek saya menanam tomat, cabai, dan terong di kebun kecil di belakang rumah.
Tolong matikan lampu ketika kamu keluar dari kamar.
Kami berencana berlibur ke pegunungan pada akhir bulan depan.
Totalnya empat puluh tujuh ribu lima ratus rupiah, sudah termasuk pajak.
"Kamu mau datang makan malam nanti?" "Iya, tapi mungkin aku agak terlambat."
Belakangan ini langit cepat mendung dan gelap karena musim hujan sudah tiba.
Aku meninggalkan kunci di atas meja dapur, di samping keranjang buah.
Anak-anak bermain di luar sampai orang tua mereka memanggil untuk makan siang.
Bisakah kamu mengirimkan laporan itu sebelum jam kerja selesai?
Ada toko roti kecil di ujung jalan yang menjual roti segar setiap pagi.
Pesawat saya berangkat pukul enam lewat lima belas, jadi saya harus sampai di bandara pukul empat.
Dia mulai belajar bermain piano ketika umurnya baru tujuh tahun.
Aduk supnya perlahan dan biarkan mendidih dengan api kecil sepuluh menit lagi.
Museum itu tutup untuk renovasi sampai tanggal tiga Maret.
Biasanya berapa lama kamu berjalan kaki ke kantor?
Angin kencang tadi malam membuat banyak daun berguguran dari pohon.
Saya ingin memesan meja untuk empat orang di dekat jendela.
Tadi pagi kami menghitung lebih dari seratus burung di danau.
Printer baru di lantai dua masih belum berfungsi dengan baik.
"Permisi, apakah kursi ini kosong?" "Ya, silakan duduk."
Kalau PR-mu cepat selesai, kita bisa pergi ke taman bersama.
Harga apel naik lagi sejak awal tahun ini.
Belok kiri di lampu merah kedua, lalu hotelnya ada di sebelah kanan Anda.
Aku lupa membeli susu, jadi kita minum kopi hitam saja.
Bisakah Anda berbicara sedikit lebih pelan? Saya tidak menangkap bagian terakhirnya.
Setiap Sabtu pagi kami membersihkan rumah, lalu pergi ke pasar.
Dokter menyuruhnya minum lebih banyak air dan beristirahat yang cukup.
Kucing itu selalu tidur di dekat jendela setiap kali matahari bersinar.
Tuliskan nomor telepon dan tanggal hari ini di bagian atas formulir.
"Filmnya mulai jam berapa?" "Kalau tidak salah jam delapan kurang seperempat."
Iris bawang merah tipis-tipis, lalu tumis dengan sedikit minyak sampai harum.
Saya sudah tinggal di lingkungan ini hampir dua belas tahun.
Boleh tolong tutup jendelanya? Di sini mulai terasa dingin.
Baterai ponselku hampir habis, jadi mungkin nanti aku tidak bisa meneleponmu.
Ayo kita bertemu besok siang jam dua belas di depan menara jam tua.
Dia menghabiskan seluruh akhir pekan untuk mengecat pagar di belakang rumah.
Apakah ada apotek di sekitar sini yang buka sampai larut malam?
Hujan deras turun tepat ketika kami sampai di puncak bukit.
Aku harus mengembalikan buku-buku ini ke perpustakaan sebelum hari Jumat.
`,

  tr: `
Hava durumuna göre bu öğleden sonra yağmur yağacak, şemsiyeni yanına al.
Affedersiniz, en yakın otobüs durağının nerede olduğunu söyleyebilir misiniz?
Her sabah işe başlamadan önce bir bardak çay içerim.
Haftalık toplantımız salı gününden perşembe günü saat üçe ertelendi.
Makarnayı atmadan önce suya bir tutam tuz ekle.
Şehir merkezindeki trafik yüzünden otobüs yirmi dakika geç geldi.
Babaannem küçük bahçesinde domates, biber ve fasulye yetiştiriyor.
Lütfen odadan çıkarken ışıkları kapatmayı ve pencereyi kontrol etmeyi unutma.
Gelecek ayın sonunda dağlara bir gezi yapmayı planlıyoruz.
Hepsi birlikte kırk yedi lira elli kuruş ediyor, buyurun.
"Bu akşam yemeğe geliyor musun?" "Evet, ama biraz geç kalabilirim."
Kış yaklaştığı için artık akşamları hava çok erken kararıyor.
Anahtarlarımı mutfak masasının üstünde, meyve tabağının yanında bıraktım.
Çocuklar, anneleri onları öğle yemeğine çağırana kadar dışarıda oynadı.
Hazırladığın raporu bugün mesai bitmeden bana gönderebilir misin?
Köşede her sabah taze ekmek satan küçük bir fırın var.
Uçağım altıyı çeyrek geçe kalkıyor, bu yüzden saat dörtte havalimanında olmalıyım.
O, piyano çalmayı henüz yedi yaşındayken öğrenmeye başlamış.
Çorbayı yavaşça karıştır ve kısık ateşte on dakika daha pişir.
Müze, tadilat nedeniyle üç Mart'a kadar kapalı kalacak.
Evden işe yürüyerek gitmen genellikle ne kadar zaman alıyor?
Dün gece esen sert rüzgar ağaçlardaki yaprakların çoğunu döktü.
Pencere kenarında dört kişilik bir masa istiyoruz, lütfen.
Bu sabah gölün kenarında yüzden fazla kuş saydık, çok güzeldi.
İkinci kattaki yeni yazıcı hâlâ düzgün çalışmıyor, birini çağırmamız lazım.
"Affedersiniz, bu koltuk boş mu?" "Evet, buyurun oturun."
Ödevlerini erken bitirirsen öğleden sonra birlikte parka gidebiliriz.
Pazardaki elmaların fiyatı yılın başından beri yine epey arttı.
İkinci trafik ışığından sola dönün, otel sağ tarafınızda olacak.
Süt almayı unuttum, o yüzden bugün kahvemizi sütsüz içmek zorundayız.
Biraz daha yavaş konuşabilir misiniz? Son kısmı anlayamadım.
Her cumartesi sabahı evi temizliyoruz, sonra pazara gidiyoruz.
Doktor ona daha çok su içmesini ve iyice dinlenmesini söyledi.
Güneş çıktığında kedi hep sıcak pencere kenarında uyur.
Lütfen formun en üstüne telefon numaranızı ve bugünün tarihini yazın.
"Film saat kaçta başlıyor?" "Sanırım sekize çeyrek var."
Soğanı ince ince doğra ve biraz yağda pembeleşene kadar kavur.
Neredeyse on iki yıldır bu mahallede oturuyorum ve burayı çok seviyorum.
Pencereyi kapatır mısın lütfen? Burası yavaş yavaş soğumaya başladı.
Telefonumun şarjı bitmek üzere, o yüzden sonra seni arayamayabilirim.
Yarın öğlen saat on ikide eski saat kulesinin önünde buluşalım.
Bütün hafta sonunu evin arkasındaki çiti boyayarak geçirdi.
Buralarda gece geç saate kadar açık olan bir eczane var mı?
Tam tepenin zirvesine vardığımız sırada hafif hafif kar yağmaya başladı.
Bu kitapları cuma gününe kadar kütüphaneye geri vermem gerekiyor.
`,

  vi: `
Dự báo thời tiết nói chiều nay trời sẽ mưa, nhớ mang theo ô nhé.
Xin lỗi, anh có thể chỉ cho tôi bến xe buýt gần nhất ở đâu không?
Sáng nào tôi cũng uống một tách trà trước khi bắt đầu làm việc.
Cuộc họp đã được dời từ thứ Ba sang ba giờ chiều thứ Năm.
Cho một chút muối vào nước trước khi thả mì vào nồi.
Xe buýt đến muộn hai mươi phút vì đường trung tâm bị kẹt xe.
Bà tôi trồng cà chua, ớt và rau thơm trong khu vườn nhỏ sau nhà.
Làm ơn tắt đèn khi bạn ra khỏi phòng nhé.
Chúng tôi dự định đi du lịch lên núi vào cuối tháng sau.
Tổng cộng là bốn trăm năm mươi nghìn đồng, đã bao gồm thuế.
"Tối nay cậu có đến ăn cơm không?" "Có, nhưng chắc mình đến hơi muộn."
Dạo này trời tối sớm hơn nhiều vì mùa đông sắp đến rồi.
Tôi để chìa khóa trên bàn bếp, ngay cạnh giỏ trái cây.
Bọn trẻ chơi ngoài sân cho đến khi bố mẹ gọi vào ăn trưa.
Bạn có thể gửi cho tôi bản báo cáo trước khi hết giờ làm không?
Ở góc phố có một tiệm bánh nhỏ bán bánh mì nóng mỗi sáng.
Chuyến bay của tôi lúc sáu giờ mười lăm, nên tôi phải ra sân bay trước bốn giờ.
Cô ấy bắt đầu học đàn piano khi mới bảy tuổi.
Khuấy nồi canh thật nhẹ rồi để lửa nhỏ thêm mười phút nữa.
Bảo tàng đóng cửa để sửa chữa cho đến ngày ba tháng Ba.
Bình thường bạn đi bộ đến chỗ làm mất bao lâu?
Đêm qua gió thổi rất mạnh làm rụng gần hết lá trên cây.
Cho tôi một bàn bốn người gần cửa sổ nhé.
Sáng nay chúng tôi đếm được hơn một trăm con chim trên hồ.
Cái máy in mới ở tầng hai vẫn chưa chạy ổn định.
"Xin lỗi, ghế này có ai ngồi chưa?" "Chưa, mời bạn ngồi."
Nếu con làm bài tập xong sớm, mình cùng đi công viên nhé.
Giá táo lại tăng lên kể từ đầu năm đến giờ.
Rẽ trái ở cột đèn giao thông thứ hai, khách sạn nằm bên tay phải.
Tôi quên mua sữa, nên hôm nay mình uống cà phê đen vậy.
Anh có thể nói chậm hơn một chút được không? Tôi chưa nghe rõ đoạn cuối.
Sáng thứ Bảy nào chúng tôi cũng dọn nhà rồi đi chợ.
Bác sĩ dặn anh ấy uống nhiều nước và nghỉ ngơi cho đầy đủ.
Hễ có nắng là con mèo lại nằm ngủ bên bậu cửa sổ.
Vui lòng ghi số điện thoại và ngày hôm nay ở phía trên tờ đơn.
"Mấy giờ phim bắt đầu?" "Hình như là tám giờ kém mười lăm."
Thái hành thật mỏng rồi phi với một ít dầu cho đến khi vàng thơm.
Tôi đã sống ở khu phố này gần mười hai năm rồi.
Bạn đóng cửa sổ giúp mình được không? Ở đây hơi lạnh rồi.
Điện thoại của tôi sắp hết pin, có lẽ lát nữa tôi không gọi được.
Trưa mai mình gặp nhau trước tháp đồng hồ cũ nhé.
Anh ấy dành cả cuối tuần để sơn lại hàng rào sau nhà.
Gần đây có hiệu thuốc nào mở cửa đến khuya không?
Tôi phải trả mấy quyển sách này cho thư viện trước thứ Sáu.
`,

  it: `
Le previsioni dicono che oggi pomeriggio pioverà, quindi porta l'ombrello.
Scusi, mi può dire dov'è la fermata dell'autobus più vicina?
Prendo sempre un caffè prima di cominciare a lavorare la mattina.
La riunione è stata spostata da martedì a giovedì alle tre.
Aggiungi un pizzico di sale all'acqua prima di buttare la pasta.
Il treno è arrivato con venti minuti di ritardo per colpa della nebbia.
Mia nonna coltiva pomodori, fagioli e peperoni nel suo piccolo orto.
Per favore, ricordati di spegnere la luce quando esci dalla stanza.
Stiamo organizzando un viaggio in montagna per la fine del mese prossimo.
In tutto fanno quarantasette euro e cinquanta centesimi.
«Vieni a cena stasera?» «Sì, ma forse arrivo un po' in ritardo.»
Adesso fa buio molto prima, perché l'inverno è ormai vicino.
Ho lasciato le chiavi sul tavolo della cucina, vicino al cesto della frutta.
I bambini hanno giocato fuori finché i genitori non li hanno chiamati per pranzo.
Mi puoi mandare la relazione entro la fine della giornata?
All'angolo c'è un piccolo forno che vende pane fresco ogni mattina.
Il mio volo parte alle sei e un quarto, quindi devo essere in aeroporto alle quattro.
Ha imparato a suonare il pianoforte quando aveva solo sette anni.
Mescola la zuppa lentamente e lasciala sobbollire per altri dieci minuti.
Il museo resterà chiuso per lavori fino al tre marzo.
Quanto ci metti di solito per andare al lavoro a piedi?
Stanotte il vento forte ha fatto cadere quasi tutte le foglie dagli alberi.
Vorrei un tavolo per quattro persone vicino alla finestra, per favore.
Stamattina abbiamo contato più di cento uccelli sul lago.
La nuova stampante al secondo piano non funziona ancora bene.
«Scusi, è libero questo posto?» «Sì, prego, si accomodi.»
Se finisci presto i compiti, andiamo insieme al parco.
Il prezzo delle mele è salito di nuovo dall'inizio dell'anno.
Giri a sinistra al secondo semaforo e troverà l'albergo sulla destra.
Ho dimenticato di comprare il latte, quindi stamattina niente cappuccino.
Potrebbe parlare un po' più lentamente? Non ho capito l'ultima parte.
Ogni sabato mattina puliamo la casa e poi andiamo al mercato.
Il medico gli ha detto di bere più acqua e di riposarsi molto.
Il gatto dorme sul davanzale caldo ogni volta che esce il sole.
Scriva il suo numero di telefono e la data di oggi in cima al modulo.
«A che ora inizia il film?» «Mi sembra alle otto meno un quarto.»
Trita finemente la cipolla e falla soffriggere in un filo d'olio.
Abito in questo quartiere da quasi dodici anni ormai.
Ti dispiace chiudere la finestra? Comincia a fare freddo qui dentro.
Il telefono è quasi scarico, quindi forse più tardi non riesco a chiamarti.
Vediamoci domani a mezzogiorno davanti alla vecchia torre dell'orologio.
Ha passato tutto il fine settimana a dipingere la recinzione dietro casa.
C'è una farmacia qui vicino che resta aperta fino a tardi?
Ha cominciato a nevicare proprio quando siamo arrivati in cima alla collina.
Devo restituire questi libri in biblioteca entro venerdì.
`,

  pl: `
Według prognozy po południu będzie padać, więc weź ze sobą parasol.
Przepraszam, czy może mi pan powiedzieć, gdzie jest najbliższy przystanek autobusowy?
Zawsze piję filiżankę kawy, zanim rano zacznę pracować przy biurku.
Spotkanie zostało przeniesione z wtorku na czwartek na godzinę piętnastą.
Dodaj szczyptę soli do wody, zanim wrzucisz makaron.
Pociąg miał dwadzieścia minut opóźnienia z powodu intensywnych opadów śniegu.
Moja babcia uprawia pomidory, fasolę i paprykę w swoim małym ogródku.
Pamiętaj, żeby zgasić światło, kiedy wychodzisz z pokoju.
Planujemy wyjazd w góry pod koniec przyszłego miesiąca.
Razem będzie czterdzieści siedem złotych i pięćdziesiąt groszy.
„Przyjdziesz dziś na kolację?” „Tak, ale mogę się trochę spóźnić.”
Teraz robi się ciemno dużo wcześniej, bo zbliża się zima.
Zostawiłem klucze na stole w kuchni, obok miski z owocami.
Dzieci bawiły się na dworze, dopóki rodzice nie zawołali ich na obiad.
Czy możesz mi wysłać ten raport przed końcem dnia?
Na rogu jest mała piekarnia, która codziennie rano sprzedaje świeży chleb.
Mój samolot odlatuje kwadrans po szóstej, więc muszę być na lotnisku o czwartej.
Nauczyła się grać na pianinie, kiedy miała zaledwie siedem lat.
Mieszaj zupę powoli i gotuj ją na małym ogniu jeszcze przez dziesięć minut.
Muzeum będzie zamknięte z powodu remontu do trzeciego marca.
Ile zwykle zajmuje ci dojście do pracy na piechotę?
Wczoraj w nocy silny wiatr strącił z drzew prawie wszystkie liście.
Poproszę stolik dla czterech osób, najlepiej przy samym oknie.
Dziś rano naliczyliśmy na jeziorze ponad sto ptaków.
Nowa drukarka na drugim piętrze wciąż nie działa jak należy.
„Przepraszam, czy to miejsce jest wolne?” „Tak, proszę siadać.”
Jeśli szybko odrobisz lekcje, pójdziemy razem do parku.
Ceny jabłek na targu znowu wzrosły od początku tego roku.
Proszę skręcić w lewo na drugich światłach, hotel będzie po prawej stronie.
Zapomniałem kupić mleka, więc dzisiaj musimy wypić kawę bez mleka.
Czy mógłby pan mówić trochę wolniej? Nie zrozumiałem ostatniej części.
W każdą sobotę rano sprzątamy mieszkanie, a potem idziemy na targ.
Lekarz kazał mu pić więcej wody i dużo odpoczywać.
Kot śpi na ciepłym parapecie zawsze, gdy wychodzi słońce.
Proszę wpisać numer telefonu i dzisiejszą datę na górze formularza.
„O której zaczyna się film?” „Chyba za kwadrans ósma.”
Pokrój drobno cebulę i podsmaż ją na odrobinie oleju na złoty kolor.
Mieszkam w tej okolicy już prawie dwanaście lat.
Możesz zamknąć okno? Robi się tu trochę zimno.
Bateria w telefonie prawie mi się wyczerpała, więc później mogę nie zadzwonić.
Spotkajmy się jutro w południe przed starą wieżą zegarową.
Spędził cały weekend na malowaniu płotu za domem.
Czy jest tu w pobliżu apteka otwarta do późna w nocy?
Zaczął padać śnieg dokładnie wtedy, gdy dotarliśmy na szczyt wzgórza.
Muszę oddać te książki do biblioteki do piątku.
`,

  sw: `
Utabiri wa hali ya hewa unasema mvua itanyesha mchana huu, hivyo beba mwavuli.
Samahani, unaweza kunieleza kituo cha basi kilicho karibu zaidi kiko wapi?
Kila asubuhi mimi hunywa kikombe cha chai kabla ya kuanza kazi.
Mkutano wetu umehamishwa kutoka Jumanne hadi Alhamisi saa tisa alasiri.
Weka chumvi kidogo kwenye maji kabla ya kutia tambi.
Basi lilichelewa dakika ishirini kwa sababu ya msongamano mkubwa wa magari mjini.
Bibi yangu hupanda nyanya, pilipili na mchicha katika bustani yake ndogo.
Tafadhali kumbuka kuzima taa zote kila unapotoka chumbani jioni.
Tunapanga kusafiri kwenda milimani mwishoni mwa mwezi ujao.
Jumla ni shilingi elfu nne na mia tano, pamoja na kodi.
"Utakuja kula chakula cha jioni leo?" "Ndiyo, lakini huenda nikachelewa kidogo."
Siku hizi mawingu mengi hufunika anga jioni kwa sababu ni msimu wa mvua.
Niliacha funguo zangu juu ya meza ya jikoni, karibu na kikapu cha matunda.
Watoto walicheza nje hadi wazazi wao walipowaita kwa chakula cha mchana.
Unaweza kunitumia ripoti hiyo kabla ya mwisho wa siku ya leo?
Kuna duka dogo la mikate pale kona ambalo huuza mkate mpya kila asubuhi.
Ndege yangu inaondoka saa kumi na mbili na robo asubuhi, hivyo lazima nifike uwanjani saa kumi.
Alianza kujifunza kupiga kinanda alipokuwa na umri wa miaka saba tu.
Koroga supu taratibu na uiache ichemke kwa moto mdogo dakika kumi zaidi.
Jumba la makumbusho litafungwa kwa ukarabati hadi tarehe tatu Machi.
Kwa kawaida inakuchukua muda gani kutembea hadi kazini?
Upepo mkali wa jana usiku uliangusha karibu majani yote ya miti.
Ningependa meza ya watu wanne karibu na dirisha, tafadhali.
Asubuhi ya leo tulihesabu ndege zaidi ya mia moja ziwani.
Printa mpya iliyoko ghorofa ya pili bado haifanyi kazi vizuri.
"Samahani, kiti hiki kina mtu?" "Hapana, karibu ukae."
Ukimaliza kazi yako ya nyumbani mapema, tutaenda bustanini pamoja.
Bei ya machungwa imepanda tena tangu mwanzo wa mwaka huu.
Pinda kushoto kwenye taa za pili za barabarani, na hoteli itakuwa upande wako wa kulia.
Nilisahau kununua maziwa, kwa hiyo leo tutakunywa chai ya rangi.
Unaweza kuongea polepole kidogo? Sikuelewa sehemu ya mwisho.
Kila Jumamosi asubuhi tunasafisha nyumba, kisha tunaenda sokoni.
Daktari alimshauri anywe maji mengi zaidi na apumzike vya kutosha.
Paka hulala karibu na dirisha kila jua linapowaka.
Andika namba yako ya simu na tarehe ya leo juu ya fomu.
"Filamu inaanza saa ngapi?" "Nadhani inaanza saa mbili kasoro robo usiku."
Katakata vitunguu vidogo vidogo, kisha vikaange kwa mafuta kidogo hadi viwe vya kahawia.
Nimeishi katika mtaa huu kwa karibu miaka kumi na miwili sasa.
Unaweza kufunga dirisha tafadhali? Kuna baridi kidogo humu ndani.
Simu yangu inakaribia kuishiwa na chaji, huenda nisiweze kukupigia baadaye.
Tukutane kesho saa sita mchana mbele ya mnara wa saa wa zamani.
Alitumia wikendi nzima kupaka rangi ua ulio nyuma ya nyumba.
Je, kuna duka la dawa karibu hapa ambalo hufunguliwa hadi usiku sana?
Nalazimika kurudisha vitabu hivi maktaba kabla ya Ijumaa.
`,
};

/** Sentences per language, in authored order. */
export const SENTENCES: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(RAW).map(([lang, text]) => [
    lang,
    text.split('\n').map((s) => s.trim()).filter(Boolean),
  ]),
);

// mulberry32, seeded from the language code: same order on every seed run.
function rng(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * n script bodies for a language. The first pass uses every sentence once in authored order (all
 * distinct); later passes repeat the list in a shuffled order that is fixed per language, never
 * placing the same sentence twice in a row across a pass boundary.
 */
export function scriptBodies(lang: string, n: number): string[] {
  const list = SENTENCES[lang];
  if (!list?.length) {
    return Array.from({ length: n }, (_, i) => `[${lang} #${i + 1}] Please read this sentence clearly at a natural pace.`);
  }
  const out: string[] = list.slice(0, n);
  const rand = rng(`scripts:${lang}`);
  while (out.length < n) {
    const pass = [...list];
    for (let i = pass.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pass[i], pass[j]] = [pass[j], pass[i]];
    }
    if (pass.length > 1 && pass[0] === out[out.length - 1]) [pass[0], pass[1]] = [pass[1], pass[0]];
    out.push(...pass.slice(0, n - out.length));
  }
  return out;
}
